/**
 * One-off repair for Workday links stored without their board path segment.
 *
 * The Workday CXS API returns externalPath ("/job/…") relative to the job
 * board, but the poller appended it to the bare host, so every Workday link
 * 404'd (jobs variant) or 500'd (site variant). The revalidator then archived
 * those rows as "posting closed", which is why the breakage stayed invisible.
 *
 *   npx tsx scripts/repair-workday-links.ts              # dry run (default)
 *   npx tsx scripts/repair-workday-links.ts --apply
 *   npx tsx scripts/repair-workday-links.ts --days=30
 *
 * Every write is gated on the rebuilt URL returning HTTP 200, so a wrong board
 * guess skips the row instead of corrupting it. The stored id is recomputed as
 * md5(company + title + link) to preserve the dedup invariant — without that,
 * the poller's next cycle would not match the row and archiveStalePostings
 * would archive it right back.
 */
import md5 from 'md5';
import { getPool, closePool } from '../src/lib/db';
import { workdayBoardUrl } from '../src/poller/pollers/ats';
import { loadATSTargets } from '../src/lib/utils/ats-discovery';
import { pool as runPool } from '../src/lib/concurrency';

const APPLY = process.argv.includes('--apply');
const DAYS = parseInt(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '30', 10);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';

interface BrokenRow {
  id: string;
  company: string;
  title: string;
  link: string;
  ats_target: string | null;
  archived: boolean;
}

const targets = loadATSTargets().filter((t) => t.ats === 'workday');
const bySlug = new Map(targets.map((t) => [t.slug.toLowerCase(), t]));
const byName = new Map(targets.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t]));

// data/ats-targets.json is shadowed by the Railway volume at runtime, so the
// local copy lags prod and misses tenants. Correct links from other sources
// (SimplifyJobs stores full Workday URLs) carry the board in their path, so
// mine them as a second opinion keyed by host.
const boardByHost = new Map<string, { slug: string; board: string }>();

async function learnBoardsFromCorrectLinks(): Promise<void> {
  const { rows } = await getPool().query<{ link: string }>(
    `SELECT DISTINCT link FROM internships
      WHERE link ~ 'myworkday(jobs|site)\\.com/' AND link !~ 'myworkday(jobs|site)\\.com/job/'`,
  );
  for (const { link } of rows) {
    try {
      const u = new URL(link);
      const parts = u.pathname.split('/').filter(Boolean);
      const jobIdx = parts.indexOf('job');
      if (jobIdx < 1) continue;
      const isSiteVariant = u.hostname.endsWith('.myworkdaysite.com');
      if (isSiteVariant) {
        // /recruiting/{tenant}/{board}/job/…
        if (parts[0] !== 'recruiting' || jobIdx < 3) continue;
        boardByHost.set(`${u.hostname}|${parts[1]}`, { slug: parts[1], board: parts[2] });
      } else {
        // /{board}/job/… — tenant is the host's first label
        boardByHost.set(u.hostname, { slug: u.hostname.split('.')[0], board: parts[jobIdx - 1] });
      }
    } catch { /* skip malformed */ }
  }
  console.log(`[repair] learned ${boardByHost.size} board mappings from correctly-linked rows`);
}

function rebuild(row: BrokenRow): string | null {
  let host: string, path: string;
  try {
    const u = new URL(row.link);
    host = u.hostname;
    path = u.pathname;
  } catch {
    return null;
  }
  if (!path.startsWith('/job/')) return null;

  const isSiteVariant = host.endsWith('.myworkdaysite.com');
  const slug = (row.ats_target || '').trim().toLowerCase()
    || (isSiteVariant ? '' : host.split('.')[0].toLowerCase());
  const target = bySlug.get(slug) || byName.get(row.company.toLowerCase());
  const learned = isSiteVariant ? boardByHost.get(`${host}|${slug}`) : boardByHost.get(host);
  const resolved = target?.board ? { slug: target.slug, board: target.board } : learned;
  if (!resolved) return null;

  return `${workdayBoardUrl(host, resolved.slug, resolved.board, isSiteVariant)}${path}`;
}

async function isLive(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA } });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const db = getPool();
  await learnBoardsFromCorrectLinks();
  const { rows } = await db.query<BrokenRow>(
    `SELECT id, company, title, link, ats_target, archived
       FROM internships
      WHERE source = 'Workday'
        AND link ~ 'myworkday(jobs|site)\\.com/job/'
        AND seen_at >= now() - ($1 || ' days')::interval`,
    [String(DAYS)],
  );
  console.log(`[repair] ${rows.length} broken Workday rows in the last ${DAYS} days (apply=${APPLY})`);

  const existingIds = new Set(
    (await db.query<{ id: string }>('SELECT id FROM internships')).rows.map((r) => r.id),
  );

  let unresolved = 0, gone = 0, repaired = 0, deduped = 0;

  await runPool(rows, 8, async (row) => {
    const fixed = rebuild(row);
    if (!fixed) { unresolved++; return; }
    if (!(await isLive(fixed))) { gone++; return; }

    const newId = md5(`${row.company}${row.title}${fixed}`);
    if (!APPLY) {
      repaired++;
      if (repaired <= 10) console.log(`  would fix [${row.archived ? 'arch' : 'ACTV'}] ${row.company}\n    ${row.link}\n -> ${fixed}`);
      return;
    }

    // A correctly-linked row for this posting may already exist (the poller
    // re-inserted it after the code fix shipped). Collapsing onto it would
    // violate the primary key, so drop the broken duplicate instead.
    if (newId !== row.id && existingIds.has(newId)) {
      await db.query('DELETE FROM internships WHERE id = $1', [row.id]);
      deduped++;
      return;
    }
    await db.query(
      `UPDATE internships
          SET id = $1, link = $2, archived = false,
              failed_check_count = 0, first_failed_at = NULL
        WHERE id = $3`,
      [newId, fixed, row.id],
    );
    existingIds.add(newId);
    repaired++;
  });

  console.log(
    `[repair] ${APPLY ? 'repaired' : 'would repair'}=${repaired} ` +
    `dropped-as-duplicate=${deduped} genuinely-gone=${gone} board-unresolved=${unresolved}`,
  );

  const { rows: [left] } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM internships
      WHERE source = 'Workday' AND link ~ 'myworkday(jobs|site)\\.com/job/'
        AND seen_at >= now() - ($1 || ' days')::interval`,
    [String(DAYS)],
  );
  console.log(`[repair] broken rows remaining in window: ${left.n}`);

  await closePool();
}

main();
