#!/usr/bin/env npx tsx
/**
 * backfill-linkedin-search-urls.ts
 *
 * Rewrites existing LinkedIn `/jobs/view/<id>` links to
 * `/jobs/search/?currentJobId=<id>`. The view URLs 301 to a generic search
 * page once the posting closes (~days). The search URL stays valid: LinkedIn
 * shows the role's title, company, and an honest "No longer accepting
 * applications" notice when expired, instead of a broken redirect.
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/backfill-linkedin-search-urls.ts          # apply
 *   npx tsx scripts/backfill-linkedin-search-urls.ts --dry    # report only
 */
import * as path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = path.join(process.cwd(), 'data', 'internships.db');
const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');

// Matches https://[any.subdomain.]linkedin.com/jobs/view/<digits>[/?#...]
// (1494/1494 active LinkedIn rows match the bare form at time of writing,
// but tolerate path/query/fragment suffixes in case future ingestion changes.)
const LINKEDIN_VIEW_RE = /^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/jobs\/view\/(\d+)(?:[/?#].*)?$/i;

function rewrite(url: string): string | null {
  const m = url.match(LINKEDIN_VIEW_RE);
  if (!m) return null;
  return `https://www.linkedin.com/jobs/search/?currentJobId=${m[1]}`;
}

function main() {
  const db = new Database(DB_PATH);
  const rows = db.prepare(
    "SELECT id, link FROM internships WHERE link LIKE '%linkedin.com/jobs/view/%'"
  ).all() as { id: string; link: string }[];

  let rewrites = 0;
  let skipped = 0;
  const samples: { from: string; to: string }[] = [];
  const update = db.prepare('UPDATE internships SET link = @link WHERE id = @id');

  const txn = db.transaction((items: { id: string; link: string }[]) => {
    for (const r of items) {
      const next = rewrite(r.link);
      if (!next || next === r.link) { skipped++; continue; }
      if (samples.length < 5) samples.push({ from: r.link, to: next });
      if (!DRY) update.run({ id: r.id, link: next });
      rewrites++;
    }
  });
  txn(rows);

  console.log(`scanned: ${rows.length}`);
  console.log(`rewrites: ${rewrites}${DRY ? ' (dry run — no changes written)' : ''}`);
  console.log(`skipped (already rewritten or unrecognized): ${skipped}`);
  if (samples.length) {
    console.log('samples:');
    for (const s of samples) console.log(`  ${s.from}\n    → ${s.to}`);
  }
  db.close();
}

main();
