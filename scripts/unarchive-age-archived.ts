#!/usr/bin/env npx tsx
/**
 * unarchive-age-archived.ts
 *
 * Un-archives rows that were archived purely by age (the `archiveStalePostings`
 * 30-day rule), leaving rows archived by failed link-checks alone.
 *
 * Companion to disabling the auto-archive-by-age call in src/poller/index.ts.
 * Age-archived rows are detected as: archived = 1 AND first_failed_at IS NULL
 * AND failed_check_count = 0. Link-check archival sets at least one of those.
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/unarchive-age-archived.ts          # apply
 *   npx tsx scripts/unarchive-age-archived.ts --dry    # report only
 */
import * as path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = path.join(process.cwd(), 'data', 'internships.db');
const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');

const WHERE_AGE_ONLY =
  "archived = 1 AND first_failed_at IS NULL AND failed_check_count = 0";

function main() {
  const db = new Database(DB_PATH);

  const before = db
    .prepare(`SELECT COUNT(*) as n FROM internships WHERE ${WHERE_AGE_ONLY}`)
    .get() as { n: number };
  const totalArchived = db
    .prepare("SELECT COUNT(*) as n FROM internships WHERE archived = 1")
    .get() as { n: number };
  const totalActive = db
    .prepare("SELECT COUNT(*) as n FROM internships WHERE archived = 0")
    .get() as { n: number };

  console.log(`pre-state: ${totalActive.n} active, ${totalArchived.n} archived`);
  console.log(`will un-archive: ${before.n} (age-only, no link-check failure)`);
  console.log(`leaving alone: ${totalArchived.n - before.n} link-check-archived rows`);

  if (!DRY) {
    const result = db
      .prepare(`UPDATE internships SET archived = 0 WHERE ${WHERE_AGE_ONLY}`)
      .run();
    console.log(`applied: ${result.changes} rows un-archived`);

    const post = db
      .prepare("SELECT COUNT(*) as n FROM internships WHERE archived = 0")
      .get() as { n: number };
    console.log(`post-state: ${post.n} active (${post.n - totalActive.n} restored)`);
  } else {
    console.log('(dry run — no changes written)');
  }

  db.close();
}

main();
