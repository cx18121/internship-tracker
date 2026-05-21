#!/usr/bin/env npx tsx
/**
 * backfill-workday-descriptions.ts
 *
 * One-shot: for every active Workday row whose description is null/empty,
 * fetch the description from the CXS detail endpoint and UPDATE the row.
 *
 * The refresh-on-rediscovery path (596c70b) eventually does this too as
 * rows are re-polled, but takes 1-2 weeks. This collapses it to one run.
 *
 * Resolution: tenant + wdInstance come from the URL subdomain (only the
 * myworkdayjobs.com variant; myworkdaysite.com doesn't embed tenant).
 * Board comes from data/ats-targets.json keyed by tenant slug.
 *
 * Rows we can't resolve (myworkdaysite.com variant + orphan tenants no
 * longer in ats-targets.json) are skipped — they'll fill via natural
 * re-poll, or not at all if the tenant config has been retired.
 *
 * Usage:
 *   npx tsx scripts/backfill-workday-descriptions.ts          # apply
 *   npx tsx scripts/backfill-workday-descriptions.ts --dry    # report only
 */
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import Database from 'better-sqlite3';

const DB_PATH = path.join(process.cwd(), 'data', 'internships.db');
const TARGETS_PATH = path.join(process.cwd(), 'data', 'ats-targets.json');
const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const REQUEST_TIMEOUT_MS = 15000;
const CONCURRENCY = 5;

function stripHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ATSTarget {
  ats: string;
  slug: string;
  board?: string;
  wdInstance?: string;
  wdDomain?: string;
}

interface ResolvedRow {
  id: string;
  link: string;
  tenant: string;
  wdInstance: string;
  board: string;
  externalPath: string;
}

function resolve(rows: { id: string; link: string }[], targets: ATSTarget[]): {
  resolved: ResolvedRow[];
  unresolved: { id: string; link: string; reason: string }[];
} {
  const targetsBySlug = new Map<string, ATSTarget>();
  for (const t of targets) {
    if (t.ats === 'workday' && t.slug) targetsBySlug.set(t.slug, t);
  }

  const resolved: ResolvedRow[] = [];
  const unresolved: { id: string; link: string; reason: string }[] = [];

  for (const r of rows) {
    const m = r.link.match(/^https:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com(\/.*)$/);
    if (!m) {
      unresolved.push({ id: r.id, link: r.link, reason: 'site-variant or non-standard URL' });
      continue;
    }
    const [, tenant, wdInstance, externalPath] = m;
    const target = targetsBySlug.get(tenant);
    if (!target?.board) {
      unresolved.push({ id: r.id, link: r.link, reason: `tenant "${tenant}" not in ats-targets.json` });
      continue;
    }
    resolved.push({ id: r.id, link: r.link, tenant, wdInstance, board: target.board, externalPath });
  }
  return { resolved, unresolved };
}

async function fetchDescription(row: ResolvedRow): Promise<string> {
  const baseHost = `${row.tenant}.${row.wdInstance}.myworkdayjobs.com`;
  try {
    const { data } = await axios.get(
      `https://${baseHost}/wday/cxs/${row.tenant}/${row.board}${row.externalPath}`,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      },
    );
    const raw = data?.jobPostingInfo?.jobDescription || '';
    return stripHtml(raw).slice(0, 4000);
  } catch {
    return '';
  }
}

async function main() {
  const db = new Database(DB_PATH);
  const rows = db
    .prepare(
      `SELECT id, link FROM internships
        WHERE source = 'Workday' AND archived = 0
          AND (description IS NULL OR description = '')`,
    )
    .all() as { id: string; link: string }[];

  const targets = (JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf-8')).targets ?? []) as ATSTarget[];
  const { resolved, unresolved } = resolve(rows, targets);

  console.log(`Workday rows missing description: ${rows.length}`);
  console.log(`  resolvable from URL + ats-targets.json: ${resolved.length}`);
  console.log(`  unresolved (skipped): ${unresolved.length}`);
  if (unresolved.length > 0 && unresolved.length <= 8) {
    console.log('  unresolved details:');
    for (const u of unresolved) console.log(`    [${u.reason}] ${u.link}`);
  }

  if (DRY) {
    console.log('(dry run — no fetches, no updates)');
    db.close();
    return;
  }

  const update = db.prepare('UPDATE internships SET description = @description WHERE id = @id');
  let filled = 0;
  let empty = 0;

  const queue = [...resolved];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) break;
        const desc = await fetchDescription(row);
        if (desc.length > 50) {
          update.run({ id: row.id, description: desc });
          filled++;
        } else {
          empty++;
        }
        if ((filled + empty) % 25 === 0) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
          process.stdout.write(`  ${filled + empty}/${resolved.length}  (${filled} filled, ${empty} empty, ${elapsed}s)\r`);
        }
      }
    }),
  );

  console.log(`\nbackfill done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`  filled: ${filled}`);
  console.log(`  empty/failed: ${empty}`);
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
