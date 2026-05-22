/**
 * LinkedIn closed-job revalidation.
 *
 * Why this exists: LinkedIn returns HTTP 200 for jobs that are no longer
 * accepting applications, so the HEAD-status check in `revalidateLinks`
 * can't detect them. Random sampling in 2026-05 showed 60% of active
 * LinkedIn rows had become stale this way.
 *
 * Detection: fetch the public guest-API endpoint
 *   https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jobId}
 * and look for the `closed-job__flavor--closed` CSS marker (or the literal
 * "No longer accepting applications" text as a redundancy). Both are
 * injected by LinkedIn's SSR when the posting is closed.
 *
 * Politeness: small concurrency, 250ms inter-request jitter, early bailout
 * on a streak of non-2xx responses (most likely rate-limit/blocking).
 */
import { getInternships, archiveInternshipsByIds } from '../lib/store';

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

// Stop early if we see this many consecutive HTTP errors — likely means
// LinkedIn has started rate-limiting us or the guest endpoint changed.
// At concurrency=1 with 1.5s jitter, a long streak indicates a real block,
// not transient noise.
const ERROR_STREAK_BAILOUT = 15;

export interface LinkedInRevalResult {
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

export async function revalidateLinkedIn(opts: { dryRun?: boolean; concurrency?: number; timeoutMs?: number; limit?: number } = {}): Promise<LinkedInRevalResult> {
  // LinkedIn rate-limits aggressively. Concurrency=1 with ~1.5s jitter
  // empirically clears their throttle on first-call. Bumping concurrency or
  // shortening jitter brought the per-request error rate from ~0% up to ~50%.
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 3));
  const timeoutMs = opts.timeoutMs ?? 10000;
  const dryRun = opts.dryRun === true;

  // Pull active rows; filter to LinkedIn rows whose URL yields a job id.
  // We only ever archive — never resurrect — so we don't need to track the
  // archived rows here.
  const all = getInternships({});
  let targets = all
    .filter(i => i.source.toLowerCase() === 'linkedin' && !i.archived)
    .map(i => ({ id: i.id, link: i.link, jobId: extractLinkedInJobId(i.link) }))
    .filter((t): t is { id: string; link: string; jobId: string } => t.jobId !== null);
  if (opts.limit && opts.limit > 0 && opts.limit < targets.length) {
    targets = targets.slice(0, opts.limit);
  }

  console.log(`[linkedin-revalidate] Starting${dryRun ? ' (DRY RUN)' : ''}: ${targets.length} active LinkedIn rows, concurrency=${concurrency}`);

  const closedIds: string[] = [];
  let openCount = 0;
  let errorCount = 0;
  let errorStreak = 0;
  let bailedEarly = false;
  const statusCounts: Record<string, number> = {};

  const queue = [...targets];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async (_, workerIdx) => {
    while (queue.length > 0 && !bailedEarly) {
      const t = queue.shift();
      if (!t) return;

      const { ok, html, status } = await fetchGuestApiHtml(t.jobId, timeoutMs);
      statusCounts[String(status)] = (statusCounts[String(status)] ?? 0) + 1;

      if (!ok) {
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
        if (isClosedHtml(html)) {
          closedIds.push(t.id);
        } else {
          openCount++;
        }
        // Polite jitter on success — keeps us well below any per-IP minute
        // limit. With concurrency=1 this puts the effective rate at ~30/min.
        await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 800) + workerIdx * 50));
      }
    }
  });
  await Promise.all(workers);

  if (!dryRun && closedIds.length > 0) {
    const archived = await archiveInternshipsByIds(closedIds);
    console.log(`[linkedin-revalidate] Archived ${archived}/${closedIds.length} closed LinkedIn postings`);
  }

  const result: LinkedInRevalResult = {
    checked: targets.length - queue.length,
    closed: closedIds.length,
    open: openCount,
    errors: errorCount,
    bailedEarly,
    statusCounts,
  };
  const tag = dryRun ? ' (DRY RUN — no rows archived)' : '';
  console.log(`[linkedin-revalidate] Done${tag}: checked=${result.checked}, closed=${result.closed}, open=${result.open}, errors=${result.errors}, bailedEarly=${result.bailedEarly}`);
  return result;
}
