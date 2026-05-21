/**
 * One-time backfill: populate the `season` column for every existing internship.
 *
 *   - parseSeason(title) returns specific season-year pairs (e.g. summer-2026,
 *     fall-2027): store as-is.
 *   - parseSeason returns year-YYYY only (no season detected): treat as
 *     summer-YYYY — bare years on intern listings almost always mean
 *     summer of that cycle.
 *   - parseSeason returns []: default to ["summer-2026"], the dominant
 *     active cycle this corpus was assembled around.
 *
 * Idempotent — re-running just rewrites the same values. New internships
 * inserted after this script runs get their season computed at write time
 * via toRow() in src/lib/store.ts, with no summer-2026 default (so a
 * "Software Engineer Intern" posted next month stays empty, not lumped
 * with the legacy backfill set).
 *
 * Usage:
 *   npx tsx scripts/backfill-season.ts            # apply
 *   npx tsx scripts/backfill-season.ts --dry-run  # report only
 *   npx tsx scripts/backfill-season.ts --force    # rewrite even non-null rows
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { deriveSeasonWithDefault } from '../src/lib/seasons';

const DB_PATH = path.join(process.cwd(), 'data', 'internships.db');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');

// Shared with src/lib/store.ts toRow() — both new-row ingestion and this
// backfill apply identical semantics so behavior stays consistent.
const deriveSeason = deriveSeasonWithDefault;

interface Row { id: string; title: string; season: string | null; }

function main(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[backfill-season] No DB at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  // Idempotent column-add — same shape src/lib/store.ts applyColumnMigrations
  // would run on next boot, but this script bypasses that path so do it here.
  try {
    db.exec('ALTER TABLE internships ADD COLUMN season TEXT');
    console.log('[backfill-season] Added season column');
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) {
      throw err;
    }
  }

  const rows = db.prepare('SELECT id, title, season FROM internships').all() as Row[];
  console.log(`[backfill-season] Loaded ${rows.length} rows from ${DB_PATH}`);

  let updated = 0;
  let skipped = 0;
  const counts = new Map<string, number>();

  const update = db.prepare('UPDATE internships SET season = ? WHERE id = ?');

  const tx = db.transaction((items: Row[]) => {
    for (const r of items) {
      const next = deriveSeason(r.title);
      const nextStr = JSON.stringify(next);
      if (!FORCE && r.season === nextStr) {
        skipped++;
      } else {
        if (!DRY_RUN) update.run(nextStr, r.id);
        updated++;
      }
      for (const t of next) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  });
  tx(rows);

  console.log(`\n[backfill-season] ${DRY_RUN ? 'Would update' : 'Updated'} ${updated}; skipped ${skipped} already-current.`);
  console.log(`Final distribution across all ${rows.length} rows:`);
  const sorted = [...counts.entries()].sort(([, a], [, b]) => b - a);
  for (const [token, n] of sorted) {
    console.log(`  ${token.padEnd(20)} ${n}`);
  }

  db.close();
}

main();
