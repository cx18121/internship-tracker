/**
 * One-shot cleanup: strip aggregator tracking params (Simplify's
 * ?utm_source=Simplify&ref=Simplify, Greenhouse's gh_src=, etc.) from the
 * stored apply `link` of existing rows.
 *
 * Usage:
 *   npx tsx scripts/strip-link-refs-cleanup.ts            # dry-run (default)
 *   npx tsx scripts/strip-link-refs-cleanup.ts --apply    # write to DB
 *
 * Targets whatever DATABASE_URL points to — local .env reads the shared
 * Railway Postgres, so --apply updates production. Always dry-run first.
 *
 * WHY this is needed even though ingestion already strips: the apply link is
 * shown to the user and clicked through to the employer verbatim. enrich.ts /
 * store.ts run stripUtm on every NEWLY-inserted row, so fresh postings are
 * already clean — but rows ingested before that path (or before gh_src was
 * added to the strip list) kept their tracking params, and the normal poll
 * SKIPS an already-seen link without rewriting it. This backfills those.
 *
 * Scope: ALL rows (active + archived). Active rows are what the UI shows now.
 * Archived rows must be cleaned too: the exact-id rediscovery path un-archives a
 * row (store.ts backfillSql sets archived=false) but does NOT rewrite its stored
 * `link`, so an archived row carrying a tracking ref would resurface VISIBLY with
 * the ref intact. Cleaning archived links closes that resurrection hole. (This is
 * dedup-neutral regardless of archived state — seenLinks is built from active
 * rows only, and `id` is never touched.)
 *
 * Only the `link` column changes — never `id`. This is dedup-neutral, and NOT
 * because the stored link feeds the id: it doesn't. The poller hashes the LIVE
 * upstream link (id = md5(company+title+stripUtm(link)), enrich.ts), and cross-
 * source dedup matches on stripUtm(storedLink) (store.ts seenLinks). Because
 * stripUtm is idempotent — stripUtm(rawStored) === stripUtm(cleanedStored) —
 * rewriting the stored link to its stripped form changes neither the seenLinks
 * key nor anything the poller computes. (Stored id and stored link are already
 * intentionally decoupled here: the cross-source `upgradeLink` path rewrites a
 * stored link to a direct ATS URL while deliberately keeping the original id.)
 * `link` has no unique constraint, so collapsing two rows to the same cleaned
 * URL is allowed (those are pre-existing duplicates, out of scope here).
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { getPool, closePool } from '../src/lib/db';
import { stripUtm } from '../src/lib/utils/normalize';

const APPLY = process.argv.includes('--apply');

interface Row {
  id: string;
  link: string;
}

async function main(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<Row>(
    `SELECT id, link FROM internships WHERE link <> ''`,
  );
  console.log(`[cleanup] Loaded ${rows.length} rows (active + archived)`);

  const updates: { id: string; before: string; after: string }[] = [];
  for (const r of rows) {
    const after = stripUtm(r.link);
    if (after !== r.link) updates.push({ id: r.id, before: r.link, after });
  }

  // ---- Report ----
  console.log(`\n=== Plan (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`  links to strip: ${updates.length} / ${rows.length}`);
  console.log(`\n  sample changes:`);
  for (const u of updates.slice(0, 12)) {
    console.log(`    - ${u.before}`);
    console.log(`      → ${u.after}`);
  }

  if (!APPLY) {
    console.log(`\n[dry-run] No DB writes. Re-run with --apply to commit.`);
    return;
  }
  if (!updates.length) {
    console.log(`\n[cleanup] Nothing to do.`);
    return;
  }

  // ---- Backup ----
  const backupDir = path.join(process.cwd(), 'data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `strip-link-refs-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(updates, null, 2));
  console.log(`\n[backup] Wrote ${updates.length} affected rows → ${backupPath}`);

  // ---- Write ----
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(`UPDATE internships SET link = $2 WHERE id = $1`, [u.id, u.after]);
    }
    await client.query('COMMIT');
    console.log(`[cleanup] Committed: updated ${updates.length} links`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[cleanup] ROLLED BACK due to error:', e);
    throw e;
  } finally {
    client.release();
  }
}

main()
  .catch(err => { console.error('[cleanup] failed:', err); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
