/**
 * LinkedIn closed-job revalidation.
 *
 * Why this exists: LinkedIn returns HTTP 200 for jobs that are no longer
 * accepting applications, so the HEAD-status check in `revalidateLinks`
 * can't detect them. Random sampling in 2026-05 showed ~15-60% of active
 * LinkedIn rows had become stale this way (varied by sample).
 *
 * Detection: fetch the public guest-API endpoint
 *   https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jobId}
 * and look for the `closed-job__flavor--closed` CSS marker (or the literal
 * "No longer accepting applications" text as a redundancy). Both are
 * injected by LinkedIn's SSR when the posting is closed.
 *
 * Politeness: concurrency=1 with ~1.5s jitter empirically clears LinkedIn's
 * rate limiter; concurrency≥3 brings the error rate to ~50%. Bails early
 * on a long streak of errors (likely IP block).
 *
 * Incremental scheduling: rather than re-checking all ~1300 active LinkedIn
 * rows daily (~33min/run), each scheduled invocation only checks rows that
 * haven't been LinkedIn-checked in the last CHECK_TTL_DAYS days. We keep
 * that history in a small sidecar JSON (separate from the shared
 * `last_checked_at` column, which tracks HEAD checks and doesn't validate
 * LinkedIn content state). Steady-state: ~5min/day for ~7-day TTL.
 */
import { getInternships, archiveInternshipsByIds } from '../lib/store';
import { pool } from '../lib/concurrency';
import { jsonStore } from '../lib/sidecar';

const GUEST_API = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

// Closed-state markers. The CSS class is the safer signal because it's
// LinkedIn's own internal namespace and unlikely to appear in posting
// descriptions; the literal text is a redundant cross-check.
const CLOSED_MARKERS = [
  /closed-job__flavor--closed/i,
  /No longer accepting applications/i,
];

// HTTP statuses that confirm the LinkedIn posting is gone. 404 means the
// guest API can't find the jobId (posting deleted), 410 is explicit Gone,
// 451 is unavailable-for-legal-reasons (rare). Treat all three as
// "archive immediately" — same as the closed-marker path.
const DEAD_STATUSES = new Set([404, 410, 451]);

// Stop early if we see this many consecutive HTTP errors — likely means
// LinkedIn has started rate-limiting us or the guest endpoint changed.
// At concurrency=1 with 1.5s jitter, a long streak indicates a real block,
// not transient noise.
const ERROR_STREAK_BAILOUT = 15;

// Days between rechecks of the same posting. With ~1300 active rows and a
// 7-day TTL, the steady-state daily slice is ~185 rows ≈ 5 min/run.
const CHECK_TTL_DAYS = 7;

interface CheckHistory {
  [id: string]: string; // ISO timestamp of the last LinkedIn-content check
}

const historyStore = jsonStore<CheckHistory>('linkedin-check-history.json', {});

export interface LinkedInRevalResult {
  /** Eligible after applying the TTL filter (excludes recently checked rows). */
  eligible: number;
  /** Actually fetched (eligible minus what's left in the queue after early bailout). */
  checked: number;
  closed: number;
  open: number;
  errors: number;
  bailedEarly: boolean;
  /** Map of HTTP status code (or -1 for fetch errors) → count, for debugging. */
  statusCounts: Record<string, number>;
}

/**
 * Extract LinkedIn's numeric job ID from any of the stored URL shapes:
 *   - https://www.linkedin.com/jobs/view/4407010454
 *   - https://www.linkedin.com/jobs/view/intern-software-engineer-...-4405076690
 *   - https://www.linkedin.com/jobs/search/?currentJobId=4412315177
 * Returns null when no ID can be extracted (host isn't linkedin, malformed URL).
 */
export function extractLinkedInJobId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith('linkedin.com')) return null;

    const cur = u.searchParams.get('currentJobId');
    if (cur && /^\d+$/.test(cur)) return cur;

    // Path form: /jobs/view/{slug-with-id-or-just-id}
    // ID is the trailing numeric run on the last path segment.
    const path = u.pathname.split('/').filter(Boolean);
    const last = path[path.length - 1] || '';
    const match = last.match(/(\d+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function fetchGuestApiHtml(jobId: string, timeoutMs: number): Promise<{ ok: boolean; html: string; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GUEST_API}${jobId}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
    });
    const html = res.ok ? await res.text() : '';
    return { ok: res.ok, html, status: res.status };
  } catch {
    return { ok: false, html: '', status: -1 };
  } finally {
    clearTimeout(timer);
  }
}

function isClosedHtml(html: string): boolean {
  return CLOSED_MARKERS.some(rx => rx.test(html));
}

export async function revalidateLinkedIn(opts: {
  dryRun?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  /** Cap on rows to check this run (debug / one-off use). */
  limit?: number;
  /** Force-check every active row, ignoring CHECK_TTL_DAYS. Use for full sweeps. */
  ignoreTtl?: boolean;
} = {}): Promise<LinkedInRevalResult> {
  // LinkedIn rate-limits aggressively. Concurrency=1 with ~1.5s jitter
  // empirically clears their throttle on first-call. Bumping concurrency or
  // shortening jitter brought the per-request error rate from ~0% up to ~50%.
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 3));
  const timeoutMs = opts.timeoutMs ?? 10000;
  const dryRun = opts.dryRun === true;
  const ignoreTtl = opts.ignoreTtl === true;

  const history = historyStore.load();
  const ttlCutoff = Date.now() - CHECK_TTL_DAYS * 24 * 60 * 60 * 1000;

  const all = await getInternships({});
  let allActive = all
    .filter(i => i.source.toLowerCase() === 'linkedin' && !i.archived)
    .map(i => ({ id: i.id, link: i.link, jobId: extractLinkedInJobId(i.link) }))
    .filter((t): t is { id: string; link: string; jobId: string } => t.jobId !== null);

  // Filter by TTL unless caller explicitly asked for a full sweep.
  let targets = allActive;
  if (!ignoreTtl) {
    targets = allActive.filter(t => {
      const last = history[t.id];
      if (!last) return true;
      const lastMs = new Date(last).getTime();
      return Number.isNaN(lastMs) || lastMs < ttlCutoff;
    });
  }

  if (opts.limit && opts.limit > 0 && opts.limit < targets.length) {
    targets = targets.slice(0, opts.limit);
  }

  const skipped = allActive.length - targets.length;
  console.log(
    `[linkedin-revalidate] Starting${dryRun ? ' (DRY RUN)' : ''}: ${targets.length} eligible LinkedIn rows ` +
      `(${skipped} skipped — checked within last ${CHECK_TTL_DAYS}d), concurrency=${concurrency}`,
  );

  const closedIds: string[] = [];
  const checkedIds: string[] = [];
  let openCount = 0;
  let errorCount = 0;
  let errorStreak = 0;
  let bailedEarly = false;
  const statusCounts: Record<string, number> = {};

  await pool(targets, concurrency, async (t, workerIdx) => {
    // bailedEarly is shared across workers; once set, each worker drops its
    // remaining items on the next iteration (up to one trailing item processed
    // per worker, matching the prior behaviour).
    if (bailedEarly) return;

    const { ok, html, status } = await fetchGuestApiHtml(t.jobId, timeoutMs);
    statusCounts[String(status)] = (statusCounts[String(status)] ?? 0) + 1;

    if (DEAD_STATUSES.has(status)) {
      // Confirmed dead — archive immediately, same as the closed-marker path.
      // Not counted as an error; reset the streak so transient 429s after a
      // run of 404s don't trigger early bailout.
      errorStreak = 0;
      checkedIds.push(t.id);
      closedIds.push(t.id);
      // No need to back off as hard — 404 is fast and cheap on LinkedIn's side.
      await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 800) + workerIdx * 50));
    } else if (!ok) {
      errorCount++;
      errorStreak++;
      if (errorStreak >= ERROR_STREAK_BAILOUT) {
        bailedEarly = true;
        console.warn(`[linkedin-revalidate] Bailing early — ${errorStreak} consecutive HTTP errors (last status=${status}); will retry on next schedule`);
      }
      // Back off harder on errors. Doubles to ~3s after an error vs. ~1.5s
      // baseline; gives LinkedIn's rate-limit bucket time to refill.
      await new Promise(r => setTimeout(r, 2500 + Math.floor(Math.random() * 1000)));
    } else {
      errorStreak = 0;
      checkedIds.push(t.id);
      if (isClosedHtml(html)) {
        closedIds.push(t.id);
      } else {
        openCount++;
      }
      // Polite jitter on success — keeps us well below any per-IP minute
      // limit. With concurrency=1 this puts the effective rate at ~30/min.
      await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 800) + workerIdx * 50));
    }
  });

  if (!dryRun) {
    if (closedIds.length > 0) {
      const archived = await archiveInternshipsByIds(closedIds);
      console.log(`[linkedin-revalidate] Archived ${archived}/${closedIds.length} closed LinkedIn postings`);
    }
    // Record successful checks so the TTL filter skips them next run.
    if (checkedIds.length > 0) {
      const now = new Date().toISOString();
      for (const id of checkedIds) history[id] = now;
      historyStore.save(history);
    }
  }

  const result: LinkedInRevalResult = {
    eligible: targets.length,
    checked: checkedIds.length + errorCount,
    closed: closedIds.length,
    open: openCount,
    errors: errorCount,
    bailedEarly,
    statusCounts,
  };
  const tag = dryRun ? ' (DRY RUN — no rows archived, history not updated)' : '';
  console.log(
    `[linkedin-revalidate] Done${tag}: eligible=${result.eligible}, checked=${result.checked}, ` +
      `closed=${result.closed}, open=${result.open}, errors=${result.errors}, bailedEarly=${result.bailedEarly}`,
  );
  return result;
}
