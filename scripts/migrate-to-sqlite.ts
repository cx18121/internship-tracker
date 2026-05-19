/**
 * migrate-to-sqlite.ts
 *
 * Migrates internship-tracker JSON storage to SQLite.
 *
 * Sources:
 *   data/internships.json  → internships table
 *   data/seen.json         → seen_ids table
 *
 * Usage:
 *   npx tsx scripts/migrate-to-sqlite.ts              # dry run
 *   npx tsx scripts/migrate-to-sqlite.ts --write       # write to data/internships.db
 *   npx tsx scripts/migrate-to-sqlite.ts --write --db /path/to/custom.db
 *
 * On --write the script:
 *   1. Backs up existing JSON files to data/backup-<timestamp>/
 *   2. Creates (or re-creates) the SQLite schema
 *   3. Inserts all records in a single transaction
 *   4. Validates counts and spot-checks random rows
 *   5. Prints a summary
 *
 * The JSON files are NOT deleted — they remain as the live source until the
 * application is updated to read from SQLite. Run this script again after each
 * polling cycle to keep SQLite in sync, or use it as a one-shot migration.
 *
 * Rollback: delete data/internships.db; nothing else changes.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const INTERNSHIPS_JSON = path.join(DATA_DIR, 'internships.json');
const SEEN_JSON = path.join(DATA_DIR, 'seen.json');

const args = process.argv.slice(2);
const WRITE_MODE = args.includes('--write');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx !== -1 ? args[dbIdx + 1] : path.join(DATA_DIR, 'internships.db');

// ---------------------------------------------------------------------------
// Types (mirrors src/types.ts)
// ---------------------------------------------------------------------------
interface Internship {
  id: string;
  title: string;
  company: string;
  location: string;
  description?: string;
  link: string;
  source: string;
  atsSource?: string;
  postedAt: string;
  seenAt: string;
  score: number | null;
  scoreLabel: string;
  matchedKeywords: string[];
  isNew: boolean;
  applied: boolean;
  archived?: boolean;
  appliedAt?: string;
  applicationUrl?: string;
  applicationStatus?: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS internships (
  id                   TEXT    PRIMARY KEY,
  title                TEXT    NOT NULL,
  company              TEXT    NOT NULL,
  location             TEXT    NOT NULL,
  description          TEXT,
  link                 TEXT    NOT NULL,
  source               TEXT    NOT NULL,
  ats_source           TEXT,
  ats_job_id           TEXT,
  ats_target           TEXT,
  posted_at            TEXT    NOT NULL,
  seen_at              TEXT    NOT NULL,
  score                INTEGER,
  score_label          TEXT,
  matched_keywords     TEXT    NOT NULL DEFAULT '[]',
  is_new               INTEGER NOT NULL DEFAULT 1,
  applied              INTEGER NOT NULL DEFAULT 0,
  archived             INTEGER NOT NULL DEFAULT 0,
  applied_at           TEXT,
  application_url      TEXT,
  application_status   TEXT,
  failed_check_count   INTEGER NOT NULL DEFAULT 0,
  first_failed_at      TEXT,
  last_checked_at      TEXT,
  multi_location       TEXT
);

CREATE INDEX IF NOT EXISTS idx_internships_score       ON internships(score DESC);
CREATE INDEX IF NOT EXISTS idx_internships_source      ON internships(source);
CREATE INDEX IF NOT EXISTS idx_internships_seen_at     ON internships(seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_internships_applied     ON internships(applied);
CREATE INDEX IF NOT EXISTS idx_internships_archived    ON internships(archived);
CREATE INDEX IF NOT EXISTS idx_internships_score_label ON internships(score_label);
CREATE INDEX IF NOT EXISTS idx_internships_is_new      ON internships(is_new);
CREATE INDEX IF NOT EXISTS idx_internships_company     ON internships(company);

CREATE TABLE IF NOT EXISTS seen_ids (
  id TEXT PRIMARY KEY
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadJson<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function backup(timestamp: string): string {
  const backupDir = path.join(DATA_DIR, `backup-${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of ['internships.json', 'seen.json']) {
    const src = path.join(DATA_DIR, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupDir, name));
    }
  }
  return backupDir;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log(`\n=== internship-tracker JSON → SQLite migration ===`);
  console.log(`Mode: ${WRITE_MODE ? 'WRITE' : 'DRY RUN'}`);
  if (WRITE_MODE) console.log(`DB: ${DB_PATH}`);
  console.log('');

  // 1. Load source data
  console.log('Loading source JSON files...');
  const internships = loadJson<Internship[]>(INTERNSHIPS_JSON);
  const seenIds = loadJson<string[]>(SEEN_JSON);
  console.log(`  internships.json: ${internships.length} records`);
  console.log(`  seen.json:        ${seenIds.length} IDs`);

  // 2. Validate source data quality
  console.log('\nValidating source data...');
  const idSet = new Set<string>();
  const errors: string[] = [];
  for (const r of internships) {
    if (!r.id)      errors.push(`Record missing id: ${JSON.stringify(r).slice(0, 80)}`);
    if (!r.title)   errors.push(`Record ${r.id} missing title`);
    if (!r.company) errors.push(`Record ${r.id} missing company`);
    if (!r.link)    errors.push(`Record ${r.id} missing link`);
    if (idSet.has(r.id)) errors.push(`Duplicate id: ${r.id}`);
    idSet.add(r.id);
  }
  if (errors.length > 0) {
    console.error(`  VALIDATION ERRORS (${errors.length}):`);
    errors.slice(0, 10).forEach(e => console.error(`    - ${e}`));
    if (errors.length > 10) console.error(`    ... and ${errors.length - 10} more`);
    console.error('\nAborting — fix data issues before migrating.');
    process.exit(1);
  }
  console.log('  OK — no issues found');

  // 3. Score distribution (informational)
  const labelCounts: Record<string, number> = {};
  for (const r of internships) {
    const l = r.scoreLabel || 'null';
    labelCounts[l] = (labelCounts[l] || 0) + 1;
  }
  console.log('\nScore distribution:');
  for (const [label, count] of Object.entries(labelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(10)} ${count}`);
  }

  if (!WRITE_MODE) {
    console.log('\n--- DRY RUN COMPLETE ---');
    console.log('No files written. Re-run with --write to execute migration.');
    console.log(`\nWould create: ${DB_PATH}`);
    console.log(`  internships table: ${internships.length} rows`);
    console.log(`  seen_ids table:    ${seenIds.length} rows`);
    return;
  }

  // 4. Backup JSON files
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = backup(ts);
  console.log(`\nBacked up JSON files to: ${backupDir}`);

  // 5. Open / create database
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 6. Create schema
  db.exec(SCHEMA);
  console.log('Schema created.');

  // 7. Clear existing data (idempotent re-run support)
  const existing = (db.prepare('SELECT COUNT(*) as n FROM internships').get() as { n: number }).n;
  if (existing > 0) {
    console.log(`\nFound ${existing} existing rows — clearing tables for fresh import...`);
    db.exec('DELETE FROM internships; DELETE FROM seen_ids;');
  }

  // 8. Insert internships
  console.log('\nInserting internships...');
  const insertInternship = db.prepare(`
    INSERT OR IGNORE INTO internships
      (id, title, company, location, description, link, source, ats_source,
       ats_job_id, ats_target,
       posted_at, seen_at, score, score_label, matched_keywords,
       is_new, applied, archived, applied_at, application_url, application_status,
       failed_check_count, first_failed_at, last_checked_at, multi_location)
    VALUES
      (@id, @title, @company, @location, @description, @link, @source, @atsSource,
       @atsJobId, @atsTarget,
       @postedAt, @seenAt, @score, @scoreLabel, @matchedKeywords,
       @isNew, @applied, @archived, @appliedAt, @applicationUrl, @applicationStatus,
       @failedCheckCount, @firstFailedAt, @lastCheckedAt, @multiLocation)
  `);

  const insertMany = db.transaction((records: any[]) => {
    for (const r of records) {
      insertInternship.run({
        id:                r.id,
        title:             r.title,
        company:           r.company,
        location:          r.location,
        description:       r.description ?? null,
        link:              r.link,
        source:            r.source,
        atsSource:         r.atsSource ?? null,
        atsJobId:          r.atsJobId ?? null,
        atsTarget:         r.atsTarget ?? null,
        postedAt:          r.postedAt,
        seenAt:            r.seenAt,
        score:             r.score ?? null,
        scoreLabel:        r.scoreLabel,
        matchedKeywords:   JSON.stringify(r.matchedKeywords ?? []),
        isNew:             r.isNew ? 1 : 0,
        applied:           r.applied ? 1 : 0,
        archived:          r.archived ? 1 : 0,
        appliedAt:         r.appliedAt ?? null,
        failedCheckCount:  r.failedCheckCount ?? 0,
        firstFailedAt:     r.firstFailedAt ?? null,
        lastCheckedAt:     r.lastCheckedAt ?? null,
        multiLocation:     r.multiLocation ? JSON.stringify(r.multiLocation) : null,
        applicationUrl:    r.applicationUrl ?? null,
        applicationStatus: r.applicationStatus ?? null,
      });
    }
  });
  insertMany(internships);

  // 9. Insert seen_ids
  console.log('Inserting seen_ids...');
  const insertSeen = db.prepare('INSERT OR IGNORE INTO seen_ids (id) VALUES (?)');
  const insertSeenMany = db.transaction((ids: string[]) => {
    for (const id of ids) insertSeen.run(id);
  });
  insertSeenMany(seenIds);

  // 10. Validate
  console.log('\nValidating migration...');
  const dbCount = (db.prepare('SELECT COUNT(*) as n FROM internships').get() as { n: number }).n;
  const seenCount = (db.prepare('SELECT COUNT(*) as n FROM seen_ids').get() as { n: number }).n;

  if (dbCount !== internships.length) {
    console.error(`  MISMATCH: JSON has ${internships.length} records, DB has ${dbCount}`);
    process.exit(1);
  }
  if (seenCount !== seenIds.length) {
    console.error(`  MISMATCH: JSON seen has ${seenIds.length} IDs, DB has ${seenCount}`);
    process.exit(1);
  }
  console.log(`  internships: ${dbCount} / ${internships.length} ✓`);
  console.log(`  seen_ids:    ${seenCount} / ${seenIds.length} ✓`);

  // Spot-check: verify 5 random records round-trip correctly
  const samples = internships
    .filter((_, i) => i % Math.floor(internships.length / 5) === 0)
    .slice(0, 5);
  const fetchRow = db.prepare('SELECT * FROM internships WHERE id = ?');
  let spotOk = true;
  for (const s of samples) {
    const row = fetchRow.get(s.id) as Record<string, unknown> | undefined;
    if (!row) { console.error(`  SPOT CHECK FAIL: missing id=${s.id}`); spotOk = false; continue; }
    if (row.title !== s.title || row.company !== s.company || row.source !== s.source) {
      console.error(`  SPOT CHECK FAIL: field mismatch for id=${s.id}`);
      spotOk = false;
    }
  }
  if (spotOk) console.log('  Spot checks (5 records): ✓');

  db.close();

  const stat = fs.statSync(DB_PATH);
  console.log(`\n=== Migration complete ===`);
  console.log(`DB: ${DB_PATH} (${(stat.size / 1024).toFixed(1)} KB)`);
  console.log(`Backup: ${backupDir}`);
  console.log('\nRollback: delete the .db file. JSON files are untouched.');
  console.log('Next step: update store.ts to read/write SQLite instead of JSON.');
}

main();
