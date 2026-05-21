import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { Internship } from './types';
import { stripUtm } from './utils/normalize';
import { deriveSeasonWithDefault } from './seasons';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'internships.db');
const internshipsJsonPath = path.join(DATA_DIR, 'internships.json');
const seenJsonPath = path.join(DATA_DIR, 'seen.json');

// ---------------------------------------------------------------------------
// Aggregator domains (link-utility, doesn't touch storage)
// ---------------------------------------------------------------------------

const AGGREGATOR_DOMAINS = new Set([
  'trabajo.org', 'recruit.net', 'jooble.org', 'jooble.com',
  'indeed.co.uk', 'indeed.com.my', 'glassdoor.com.au',
  'simplyhired.com', 'ziprecruiter.com', 'careerbliss.com',
  'casalesadvantage.com', 'tarta.ai', 'talent.com', 'jobylon.com',
  'jobrapido.com', 'jobsite.co.uk', 'cvlibrary.co.uk', 'totaljobs.com',
  'monster.com', 'dice.com', 'careerbuilder.com', 'hotjobs.com',
  'beyond.com', 'employmentguide.com', 'jobs2careers.com', 'neuvoo.com',
  'careerjet.com', 'instahyre.com', 'workopolis.com', 'elut.ca',
  'trovit.com', 'kariera.gr', 'jobbol.com',
  'jobleads.com', 'learn4good.com',
  'talent.apple.com', 'jobs.disneycareers.com',
]);

export function isAggregatorLink(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const lower = hostname.toLowerCase().replace(/^www\./, '');
    for (const agg of AGGREGATOR_DOMAINS) {
      // Match the hostname exactly or as a subdomain. Plain .includes()
      // produced false positives like "my-dice.com" matching "dice.com".
      if (lower === agg || lower.endsWith('.' + agg)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export async function checkLinkStatus(url: string, timeoutMs = 3000): Promise<number> {
  try {
    const http = await import('http');
    const https = await import('https');
    return await new Promise((resolve) => {
      const isHttps = url.startsWith('https://');
      const mod = isHttps ? https : http;
      const req = mod.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
        resolve(res.statusCode ?? -1);
      });
      req.on('error', () => {
        const getReq = mod.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
          resolve(res.statusCode ?? -1);
        });
        getReq.on('error', () => resolve(-1));
        getReq.on('timeout', () => { getReq.destroy(); resolve(-1); });
        getReq.end();
      });
      req.on('timeout', () => { req.destroy(); resolve(-1); });
      req.end();
    });
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Schema (must match scripts/migrate-to-sqlite.ts)
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

// Columns added after the initial schema. Run idempotently on every boot —
// ALTER TABLE ADD COLUMN throws if the column exists, which we swallow.
const LATER_COLUMNS: Array<{ col: string; def: string }> = [
  { col: 'salary_text',    def: 'TEXT' },
  { col: 'salary_min',     def: 'REAL' },
  { col: 'salary_max',     def: 'REAL' },
  { col: 'salary_unit',    def: 'TEXT' },
  { col: 'normalized_key', def: 'TEXT' },
  // "Not interested" flag (set by the Discord ❌ button). Hidden postings
  // stop showing in the UI and won't re-alert. Independent of `archived`,
  // which is used for stale / dead-link postings.
  { col: 'hidden',         def: 'INTEGER NOT NULL DEFAULT 0' },
  // Season tokens (JSON array, e.g. '["summer-2026"]') parsed from title at
  // write time. Lets the UI/notifier read pre-computed seasons instead of
  // parsing on every render. Backfilled once for legacy rows via
  // scripts/backfill-season.ts; nullable until then.
  { col: 'season',         def: 'TEXT' },
];

const LATER_INDEXES: Array<{ name: string; sql: string }> = [
  { name: 'idx_internships_normalized_key', sql: 'CREATE INDEX IF NOT EXISTS idx_internships_normalized_key ON internships(normalized_key)' },
  { name: 'idx_internships_hidden',         sql: 'CREATE INDEX IF NOT EXISTS idx_internships_hidden ON internships(hidden)' },
];

function applyColumnMigrations(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(internships)`).all() as { name: string }[];
  const existing = new Set(cols.map(c => c.name));
  for (const { col, def } of LATER_COLUMNS) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE internships ADD COLUMN ${col} ${def}`);
    }
  }
  for (const { sql } of LATER_INDEXES) db.exec(sql);
}

// ---------------------------------------------------------------------------
// Database singleton + auto-migration from JSON if first run
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

/** Close the active SQLite handle (if any) for graceful shutdown. Safe to call multiple times. */
export function closeDb(): void {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

function getDb(): Database.Database {
  if (_db) return _db;

  const dbExists = fs.existsSync(DB_PATH);
  const jsonExists = fs.existsSync(internshipsJsonPath);

  // First-boot auto-migration: if no DB but JSON exists, run the migration once.
  if (!dbExists && jsonExists) {
    console.log('[store] No internships.db found but internships.json exists — auto-migrating...');
    autoMigrateFromJson();
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');       // concurrent reads while one writer
  _db.pragma('synchronous = NORMAL');     // fast + still durable
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  applyColumnMigrations(_db);
  return _db;
}

function autoMigrateFromJson(): void {
  try {
    const internshipsRaw = fs.readFileSync(internshipsJsonPath, 'utf-8');
    const internships: Internship[] = JSON.parse(internshipsRaw);
    const seen: string[] = fs.existsSync(seenJsonPath)
      ? JSON.parse(fs.readFileSync(seenJsonPath, 'utf-8'))
      : [];

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    applyColumnMigrations(db);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO internships
        (id, title, company, location, description, link, source, ats_source,
         ats_job_id, ats_target, posted_at, seen_at, score, score_label,
         matched_keywords, is_new, applied, archived, applied_at,
         application_url, application_status, failed_check_count,
         first_failed_at, last_checked_at, multi_location,
         salary_text, salary_min, salary_max, salary_unit, normalized_key, hidden, season)
      VALUES (@id, @title, @company, @location, @description, @link, @source,
        @atsSource, @atsJobId, @atsTarget, @postedAt, @seenAt, @score,
        @scoreLabel, @matchedKeywords, @isNew, @applied, @archived, @appliedAt,
        @applicationUrl, @applicationStatus, @failedCheckCount, @firstFailedAt,
        @lastCheckedAt, @multiLocation,
        @salaryText, @salaryMin, @salaryMax, @salaryUnit, @normalizedKey, @hidden, @season)
    `);
    const insertMany = db.transaction((records: Internship[]) => {
      for (const r of records) insert.run(toRow(r));
    });
    insertMany(internships);

    const insertSeen = db.prepare('INSERT OR IGNORE INTO seen_ids (id) VALUES (?)');
    const insertSeenMany = db.transaction((ids: string[]) => {
      for (const id of ids) insertSeen.run(id);
    });
    insertSeenMany(seen);

    db.close();
    console.log(`[store] Auto-migrated ${internships.length} internships + ${seen.length} seen IDs to SQLite.`);
  } catch (err) {
    console.error('[store] Auto-migration failed; starting with empty DB:', err);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ Internship mappers
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string | null;
  link: string;
  source: string;
  ats_source: string | null;
  ats_job_id: string | null;
  ats_target: string | null;
  posted_at: string;
  seen_at: string;
  score: number | null;
  score_label: string | null;
  matched_keywords: string;
  is_new: number;
  applied: number;
  archived: number;
  applied_at: string | null;
  application_url: string | null;
  application_status: string | null;
  failed_check_count: number;
  first_failed_at: string | null;
  last_checked_at: string | null;
  multi_location: string | null;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_unit: string | null;
  normalized_key: string | null;
  hidden: number;
  season: string | null;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T, field: string, rowId: string): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch (e: any) {
    console.warn(`[store] fromRow: malformed ${field} JSON on row ${rowId} (${e.message}) — using fallback`);
    return fallback;
  }
}

function fromRow(r: Row): Internship {
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    location: r.location,
    description: r.description ?? undefined,
    link: r.link,
    source: r.source,
    atsSource: r.ats_source ?? undefined,
    atsJobId: r.ats_job_id ?? undefined,
    atsTarget: r.ats_target ?? undefined,
    postedAt: r.posted_at,
    seenAt: r.seen_at,
    score: r.score,
    scoreLabel: r.score_label ?? '',
    matchedKeywords: safeJsonParse<string[]>(r.matched_keywords, [], 'matched_keywords', r.id),
    isNew: r.is_new === 1,
    applied: r.applied === 1,
    archived: r.archived === 1,
    appliedAt: r.applied_at ?? undefined,
    applicationUrl: r.application_url ?? undefined,
    applicationStatus: r.application_status ?? undefined,
    failedCheckCount: r.failed_check_count,
    firstFailedAt: r.first_failed_at ?? undefined,
    lastCheckedAt: r.last_checked_at ?? undefined,
    multiLocation: safeJsonParse<string[] | undefined>(r.multi_location, undefined, 'multi_location', r.id),
    salaryText: r.salary_text ?? undefined,
    salaryMin: r.salary_min ?? undefined,
    salaryMax: r.salary_max ?? undefined,
    salaryUnit: (r.salary_unit as Internship['salaryUnit']) ?? undefined,
    normalizedKey: r.normalized_key ?? undefined,
    hidden: r.hidden === 1,
    season: safeJsonParse<string[] | undefined>(r.season, undefined, 'season', r.id),
  };
}

function toRow(i: Internship): Record<string, unknown> {
  return {
    id: i.id,
    title: i.title,
    company: i.company,
    location: i.location,
    description: i.description ?? null,
    link: i.link,
    source: i.source,
    atsSource: i.atsSource ?? null,
    atsJobId: i.atsJobId ?? null,
    atsTarget: i.atsTarget ?? null,
    postedAt: i.postedAt,
    seenAt: i.seenAt,
    score: i.score ?? null,
    scoreLabel: i.scoreLabel ?? '',
    matchedKeywords: JSON.stringify(i.matchedKeywords ?? []),
    isNew: i.isNew ? 1 : 0,
    applied: i.applied ? 1 : 0,
    archived: i.archived ? 1 : 0,
    appliedAt: i.appliedAt ?? null,
    applicationUrl: i.applicationUrl ?? null,
    applicationStatus: i.applicationStatus ?? null,
    failedCheckCount: i.failedCheckCount ?? 0,
    firstFailedAt: i.firstFailedAt ?? null,
    lastCheckedAt: i.lastCheckedAt ?? null,
    multiLocation: i.multiLocation ? JSON.stringify(i.multiLocation) : null,
    salaryText: i.salaryText ?? null,
    salaryMin: i.salaryMin ?? null,
    salaryMax: i.salaryMax ?? null,
    salaryUnit: i.salaryUnit ?? null,
    normalizedKey: i.normalizedKey ?? null,
    hidden: i.hidden ? 1 : 0,
    // Auto-populate from title on every write so the column stays in sync
    // with the title. Titles without explicit season/year fall back to the
    // current intern cycle (summer-YYYY) so they still match season chips —
    // mirrors the one-time backfill script. Callers can override by setting
    // i.season explicitly.
    season: JSON.stringify(i.season ?? deriveSeasonWithDefault(i.title)),
  };
}

// ---------------------------------------------------------------------------
// In-process mutex for the polling cycle (prevents concurrent dedup races)
// ---------------------------------------------------------------------------

let storeLock: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = storeLock.then(() => fn() as Promise<T>);
  storeLock = next.then(() => {}, (err) => { console.error('[store] lock error:', err); });
  return next;
}

// ---------------------------------------------------------------------------
// Public storage API
// ---------------------------------------------------------------------------

export function loadInternships(): Internship[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM internships ORDER BY seen_at DESC').all() as Row[];
  return rows.map(fromRow);
}

/**
 * Full-replace write — kept for callers that still expect array semantics.
 * Slower than targeted updates; prefer `patchInternship` / `archiveStalePostings`
 * / `deduplicateAndStore` for hot paths.
 */
export function saveInternships(internships: Internship[]): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO internships
      (id, title, company, location, description, link, source, ats_source,
       ats_job_id, ats_target, posted_at, seen_at, score, score_label,
       matched_keywords, is_new, applied, archived, applied_at,
       application_url, application_status, failed_check_count,
       first_failed_at, last_checked_at, multi_location,
       salary_text, salary_min, salary_max, salary_unit, normalized_key, hidden, season)
    VALUES (@id, @title, @company, @location, @description, @link, @source,
      @atsSource, @atsJobId, @atsTarget, @postedAt, @seenAt, @score,
      @scoreLabel, @matchedKeywords, @isNew, @applied, @archived, @appliedAt,
      @applicationUrl, @applicationStatus, @failedCheckCount, @firstFailedAt,
      @lastCheckedAt, @multiLocation,
      @salaryText, @salaryMin, @salaryMax, @salaryUnit, @normalizedKey, @hidden, @season)
    ON CONFLICT(id) DO UPDATE SET
      title              = excluded.title,
      company            = excluded.company,
      location           = excluded.location,
      description        = excluded.description,
      link               = excluded.link,
      source             = excluded.source,
      ats_source         = excluded.ats_source,
      ats_job_id         = excluded.ats_job_id,
      ats_target         = excluded.ats_target,
      posted_at          = excluded.posted_at,
      seen_at            = excluded.seen_at,
      score              = excluded.score,
      score_label        = excluded.score_label,
      matched_keywords   = excluded.matched_keywords,
      is_new             = excluded.is_new,
      applied            = excluded.applied,
      archived           = excluded.archived,
      applied_at         = excluded.applied_at,
      application_url    = excluded.application_url,
      application_status = excluded.application_status,
      failed_check_count = excluded.failed_check_count,
      first_failed_at    = excluded.first_failed_at,
      last_checked_at    = excluded.last_checked_at,
      multi_location     = excluded.multi_location,
      salary_text        = excluded.salary_text,
      salary_min         = excluded.salary_min,
      salary_max         = excluded.salary_max,
      salary_unit        = excluded.salary_unit,
      normalized_key     = excluded.normalized_key,
      hidden             = excluded.hidden,
      season             = excluded.season
  `);
  const upsertMany = db.transaction((records: Internship[]) => {
    for (const r of records) upsert.run(toRow(r));
  });
  upsertMany(internships);
}

export interface StoreResult {
  newInternships: Internship[];
  totalStored: number;
  // Per-source counts of items entering dedup (post-filter). Useful when paired
  // with netNewBySource to see whether a source is fetching but always
  // deduping against existing rows — i.e., contributing zero new coverage.
  incomingBySource: Record<string, number>;
  // Per-source counts of items that actually got stored (passed all three
  // dedup checks). The genuine "coverage contribution" of each source per cycle.
  netNewBySource: Record<string, number>;
}

export async function deduplicateAndStore(incoming: Internship[]): Promise<StoreResult> {
  return withLock(() => {
    const db = getDb();

    // Build seenLinks + seenKeys sets from existing rows for cross-source dedup.
    // Also index by normalized_key so the dedup loop can upgrade a stored row's
    // link when a later source finds the same role via a direct apply URL
    // (SimplifyJobs frequently falls back to simplify.jobs wrappers).
    const seenLinkRows = db.prepare('SELECT id, link, normalized_key FROM internships WHERE archived = 0').all() as { id: string; link: string; normalized_key: string | null }[];
    const seenLinks = new Set<string>();
    const seenKeys = new Set<string>();
    const rowByKey = new Map<string, { id: string; link: string }>();
    for (const row of seenLinkRows) {
      if (row.link) seenLinks.add(stripUtm(row.link));
      if (row.normalized_key) {
        seenKeys.add(row.normalized_key);
        rowByKey.set(row.normalized_key, { id: row.id, link: row.link });
      }
    }

    const existingIdRow = db.prepare('SELECT id FROM seen_ids WHERE id = ?');
    const insertSeen = db.prepare('INSERT OR IGNORE INTO seen_ids (id) VALUES (?)');
    const upgradeLink = db.prepare('UPDATE internships SET link = @link WHERE id = @id');
    const insertInternship = db.prepare(`
      INSERT OR IGNORE INTO internships
        (id, title, company, location, description, link, source, ats_source,
         ats_job_id, ats_target, posted_at, seen_at, score, score_label,
         matched_keywords, is_new, applied, archived, applied_at,
         application_url, application_status, failed_check_count,
         first_failed_at, last_checked_at, multi_location,
         salary_text, salary_min, salary_max, salary_unit, normalized_key, hidden, season)
      VALUES (@id, @title, @company, @location, @description, @link, @source,
        @atsSource, @atsJobId, @atsTarget, @postedAt, @seenAt, @score,
        @scoreLabel, @matchedKeywords, @isNew, @applied, @archived, @appliedAt,
        @applicationUrl, @applicationStatus, @failedCheckCount, @firstFailedAt,
        @lastCheckedAt, @multiLocation,
        @salaryText, @salaryMin, @salaryMax, @salaryUnit, @normalizedKey, @hidden, @season)
    `);

    const newInternships: Internship[] = [];
    const incomingBySource: Record<string, number> = {};
    const netNewBySource: Record<string, number> = {};

    for (const i of incoming) {
      const src = i.source || 'Unknown';
      incomingBySource[src] = (incomingBySource[src] || 0) + 1;
    }

        const txn = db.transaction((items: Internship[]) => {
      for (const i of items) {
        // Exact id seen?
        if (existingIdRow.get(i.id)) continue;

        // Same posting via different UTM params?
        const normalizedLink = stripUtm(i.link || '');
        if (i.link && seenLinks.has(normalizedLink)) continue;

        // Same role posted by another source (normalized company + title)?
        if (i.normalizedKey && seenKeys.has(i.normalizedKey)) {
          // If the stored row's link is a simplify.jobs wrapper and the
          // incoming row has a direct apply URL, upgrade the stored link
          // in place. Source attribution (first-discoverer) is preserved.
          const existing = rowByKey.get(i.normalizedKey);
          if (
            existing &&
            existing.link.includes('simplify.jobs') &&
            normalizedLink &&
            !normalizedLink.includes('simplify.jobs')
          ) {
            upgradeLink.run({ id: existing.id, link: normalizedLink });
            rowByKey.set(i.normalizedKey, { id: existing.id, link: normalizedLink });
            seenLinks.add(normalizedLink);
          }
          continue;
        }

        if (i.link) seenLinks.add(normalizedLink);
        if (i.normalizedKey) seenKeys.add(i.normalizedKey);

        const stored: Internship = { ...i, link: normalizedLink || i.link, isNew: true };
        insertInternship.run(toRow(stored));
        insertSeen.run(stored.id);
        newInternships.push(stored);
        // Track this row so a later item in the same batch can upgrade its
        // link if a direct apply URL turns up after a simplify.jobs one.
        if (stored.normalizedKey && stored.link) {
          rowByKey.set(stored.normalizedKey, { id: stored.id, link: stored.link });
        }
        const src = stored.source || 'Unknown';
        netNewBySource[src] = (netNewBySource[src] || 0) + 1;
      }
    });
    txn(incoming);

    const totalStored = (db.prepare('SELECT COUNT(*) as n FROM internships').get() as { n: number }).n;
    return { newInternships, totalStored, incomingBySource, netNewBySource };
  });
}

export function patchInternship(id: string, patch: Partial<Internship>): Internship | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM internships WHERE id = ?').get(id) as Row | undefined;
  if (!existing) return null;

  const merged: Internship = { ...fromRow(existing), ...patch };
  saveInternships([merged]);
  return merged;
}

export function archiveStalePostings(daysOld = 30): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('UPDATE internships SET archived = 1 WHERE archived = 0 AND seen_at < ?').run(cutoff);
  const count = result.changes;
  if (count > 0) {
    console.log(`[store] Archived ${count} stale postings older than ${daysOld} days`);
  }
  return count;
}

export function getStats(): {
  total: number;
  bySource: Record<string, number>;
  byLabel: Record<string, number>;
  lastPolledAt: string | null;
  exclusionCounts: Record<string, number>;
  lastCycleSourceCounts: Record<string, number>;
  lastCycleNetNewBySource: Record<string, number>;
} {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as n FROM internships').get() as { n: number }).n;

  const bySourceRows = db.prepare(`
    SELECT source, COUNT(*) as n FROM internships GROUP BY source
  `).all() as { source: string; n: number }[];
  const bySource: Record<string, number> = {};
  for (const r of bySourceRows) bySource[r.source] = r.n;

  const byLabelRows = db.prepare(`
    SELECT score_label, COUNT(*) as n FROM internships GROUP BY score_label
  `).all() as { score_label: string; n: number }[];
  const byLabel: Record<string, number> = {};
  for (const r of byLabelRows) byLabel[r.score_label || ''] = r.n;

  const lastSeen = db.prepare(`SELECT seen_at FROM internships ORDER BY seen_at DESC LIMIT 1`).get() as { seen_at: string } | undefined;
  const lastPolledAt = lastSeen?.seen_at ?? null;

  let exclusionCounts: Record<string, number> = {};
  let lastCycleSourceCounts: Record<string, number> = {};
  let lastCycleNetNewBySource: Record<string, number> = {};
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'poll-stats.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    exclusionCounts = parsed.exclusionCounts ?? {};
    lastCycleSourceCounts = parsed.sourceCounts ?? {};
    lastCycleNetNewBySource = parsed.netNewBySource ?? {};
  } catch {}

  return { total, bySource, byLabel, lastPolledAt, exclusionCounts, lastCycleSourceCounts, lastCycleNetNewBySource };
}

/**
 * Persisted per-poll exclusion counts. Stays as a flat JSON file — it's tiny
 * latest-only state, no need to occupy a DB table.
 *
 * sourceCounts = raw fetched per source (pre-filter); netNewBySource = items
 * that survived dedup and got stored (the real coverage contribution).
 */
export function savePollStats(stats: {
  polledAt: string;
  sourceCounts?: Record<string, number>;
  netNewBySource?: Record<string, number>;
  exclusionCounts: Record<string, number>;
}): void {
  const statsPath = path.join(DATA_DIR, 'poll-stats.json');
  // Merge per-source counts with the previous cycle's so a partial cycle
  // (e.g. the fast tier polling only SimplifyJobs) doesn't wipe last-cycle
  // stats for the sources it didn't poll. Each source keeps its most-recent
  // figures from whichever cycle last touched it.
  let prev: { sourceCounts?: Record<string, number>; netNewBySource?: Record<string, number> } = {};
  try {
    prev = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  } catch {}
  const sourceCounts = { ...(prev.sourceCounts ?? {}), ...(stats.sourceCounts ?? {}) };
  const netNewBySource = { ...(prev.netNewBySource ?? {}), ...(stats.netNewBySource ?? {}) };
  fs.writeFileSync(statsPath, JSON.stringify({
    polledAt: stats.polledAt,
    sourceCounts,
    netNewBySource,
    exclusionCounts: stats.exclusionCounts,
  }, null, 2));
}

export { getStats as getLatestPollStats };

export function getInternships(filters?: {
  source?: string;
  minScore?: number;
  label?: string;
  includeArchived?: boolean;
  includeHidden?: boolean;
  sort?: 'newest' | 'posted' | 'score';
  search?: string;
}): Internship[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (!filters?.includeArchived) where.push('archived = 0');
  if (!filters?.includeHidden) where.push('hidden = 0');
  if (filters?.source) {
    where.push('LOWER(source) = @source');
    params.source = filters.source.toLowerCase();
  }
  if (filters?.minScore !== undefined) {
    where.push('COALESCE(score, 0) >= @minScore');
    params.minScore = filters.minScore;
  }
  if (filters?.label) {
    where.push('LOWER(score_label) = @label');
    params.label = filters.label.toLowerCase();
  }
  if (filters?.search) {
    where.push('(LOWER(title) LIKE @q OR LOWER(company) LIKE @q OR LOWER(location) LIKE @q)');
    params.q = `%${filters.search.toLowerCase()}%`;
  }

  const orderBy = filters?.sort === 'newest'
    ? 'seen_at DESC'
    : filters?.sort === 'posted'
    ? 'posted_at DESC'
    : 'COALESCE(score, 0) DESC';

  const sql = `SELECT * FROM internships${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy}`;
  const rows = db.prepare(sql).all(params) as Row[];
  return rows.map(fromRow);
}

// ---------------------------------------------------------------------------
// Link revalidation (uses storage layer via patches)
// ---------------------------------------------------------------------------

export interface RevalidationResult {
  checked: number;
  stale: number;
  stillStale: number;
  recovered: number;
  archived: number;
  aggregatorFound: number;
  errors: number;
  kept: number;
}

async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export async function revalidateLinks(opts: { dryRun?: boolean } = {}): Promise<RevalidationResult> {
  const db = getDb();
  const now = new Date().toISOString();
  const BATCH_SIZE = 20;

  const activeRows = db.prepare('SELECT * FROM internships WHERE archived = 0 AND hidden = 0').all() as Row[];
  const active = activeRows.map(fromRow);
  console.log(`[revalidate] Starting${opts.dryRun ? ' (DRY RUN)' : ''}: ${active.length} entries to check in batches of ${BATCH_SIZE}`);

  const result: RevalidationResult = {
    checked: active.length,
    stale: 0, stillStale: 0, recovered: 0, archived: 0,
    aggregatorFound: 0, errors: 0, kept: 0,
  };

  const updates: Internship[] = [];

  // First pass: aggregator domains → archive immediately
  for (const entry of active) {
    if (isAggregatorLink(entry.link)) {
      entry.failedCheckCount = 2;
      entry.firstFailedAt = entry.firstFailedAt ?? now;
      entry.lastCheckedAt = now;
      if (!opts.dryRun) entry.archived = true;
      result.aggregatorFound++;
      updates.push(entry);
    }
  }

  const toHttpCheck = active.filter(e => !e.archived && !isAggregatorLink(e.link));
  console.log(`[revalidate] ${toHttpCheck.length} need HTTP checks (${result.aggregatorFound} are aggregators)`);

  await processBatch(toHttpCheck, BATCH_SIZE, async (entry) => {
    let status: number;
    try {
      status = await checkLinkStatus(entry.link, 3000);
    } catch {
      status = -1;
    }
    entry.lastCheckedAt = now;

    // 401 = auth required (board moved private), 403 (some sites) too.
    // 410 / 451 = explicit gone. 404 = not found.
    // 429 / 5xx = transient (rate-limited or server hiccup).
    const PERMANENT = new Set([401, 404, 410, 451]);
    if (status >= 400 && PERMANENT.has(status)) {
      entry.failedCheckCount = 2;
      if (!opts.dryRun) entry.archived = true;
      result.archived++;
    } else if (status >= 400) {
      // Transient (403/429/5xx) — don't increment count
    } else if (status === -1) {
      result.errors++;
    } else if (entry.failedCheckCount !== undefined && entry.failedCheckCount > 0) {
      entry.failedCheckCount = 0;
      entry.firstFailedAt = undefined;
      result.recovered++;
      result.kept++;
    } else {
      result.kept++;
    }
    updates.push(entry);
    return entry;
  });

  if (!opts.dryRun && updates.length > 0) {
    saveInternships(updates);
  }

  console.log(
    `[revalidate] checked=${result.checked} kept=${result.kept} ` +
    `archived=${result.archived} aggregatorFound=${result.aggregatorFound} ` +
    `errors=${result.errors} recovered=${result.recovered}${opts.dryRun ? ' [DRY RUN]' : ''}`
  );

  return result;
}

export async function validateLinkForIngest(entry: Internship): Promise<Internship | null> {
  if (isAggregatorLink(entry.link)) {
    console.warn(`[store] Skipping aggregator link: ${entry.link}`);
    return null;
  }
  try {
    const status = await checkLinkStatus(entry.link, 3000);
    if (status >= 400) {
      console.warn(`[store] Skipping dead link (${status}): ${entry.link}`);
      return null;
    }
  } catch {
    // Transient error — accept; revalidation will catch dead links later.
  }
  return entry;
}

// Test-only helper: kept for compatibility with src/poller/test.ts
export function _deleteInternshipForTest(id: string): void {
  getDb().prepare('DELETE FROM internships WHERE id = ?').run(id);
}
