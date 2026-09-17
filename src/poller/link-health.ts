import type { Internship } from '../lib/types';
import { getInternships, archiveInternshipsByIds, markLinkChecked } from '../lib/store';
import { pool } from '../lib/concurrency';
import { POLLED_SOURCES } from './sources';

/**
 * Liveness of rows that only a feed vouches for. Rows from boards we poll
 * every cycle are handled by the seen_at rule in reevaluate.ts; feeds
 * (SimplifyJobs, LinkedIn) keep listing a job for weeks after it closes, so
 * those rows get a direct check every CHECK_TTL_DAYS.
 *
 * LinkedIn returns 200 for closed jobs, so its rows are checked through the
 * guest API's closed marker instead of the HTTP status.
 */

const CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const GONE_STATUSES = new Set([401, 404, 410, 451]);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

export type LinkState = 'live' | 'gone' | 'unknown';

export function extractLinkedInJobId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith('linkedin.com')) return null;
    const cur = u.searchParams.get('currentJobId');
    if (cur && /^\d+$/.test(cur)) return cur;
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return last.match(/(\d+)$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function linkedInState(url: string): Promise<LinkState> {
  const id = extractLinkedInJobId(url);
  if (!id) return 'unknown';
  try {
    const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (GONE_STATUSES.has(res.status)) return 'gone';
    if (!res.ok) return 'unknown';
    const html = await res.text();
    return /closed-job__flavor--closed|No longer accepting applications/i.test(html) ? 'gone' : 'live';
  } catch {
    return 'unknown';
  }
}

/** HTTP status of a HEAD request (GET on HEAD error); -1 on network error or timeout. */
export async function checkLinkStatus(url: string, timeoutMs = TIMEOUT_MS): Promise<number> {
  const attempt = async (method: 'HEAD' | 'GET'): Promise<number> =>
    (await fetch(url, { method, redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })).status;
  try {
    return await attempt('HEAD');
  } catch {
    return attempt('GET').catch(() => -1);
  }
}

export async function linkState(url: string): Promise<LinkState> {
  if (/linkedin\.com/.test(url)) return linkedInState(url);
  const status = await checkLinkStatus(url);
  if (GONE_STATUSES.has(status)) return 'gone';
  return status === -1 ? 'unknown' : 'live';
}

export function needsCheck(i: Internship, now = Date.now()): boolean {
  if (POLLED_SOURCES.has(i.source)) return false;
  return !i.lastCheckedAt || now - new Date(i.lastCheckedAt).getTime() > CHECK_TTL_MS;
}

export async function checkFeedLinks(): Promise<{ checked: number; archived: number; unknown: number }> {
  const due = (await getInternships()).filter(i => needsCheck(i));
  const gone: string[] = [];
  const checked: string[] = [];
  let unknown = 0;
  // LinkedIn throttles above roughly one request per second; other hosts tolerate more.
  const linkedin = due.filter(i => /linkedin\.com/.test(i.link));
  const others = due.filter(i => !/linkedin\.com/.test(i.link));
  const run = async (i: Internship) => {
    const state = await linkState(i.link);
    if (state === 'unknown') { unknown++; return; }
    checked.push(i.id);
    if (state === 'gone') gone.push(i.id);
  };
  await Promise.all([
    pool(others, 8, run),
    (async () => { for (const i of linkedin) { await run(i); await new Promise(r => setTimeout(r, 1200)); } })(),
  ]);
  await markLinkChecked(checked, gone);
  const archived = await archiveInternshipsByIds(gone);
  console.log(`[link-health] checked ${checked.length}/${due.length} feed rows, archived ${archived}, unknown ${unknown}`);
  return { checked: checked.length, archived, unknown };
}
