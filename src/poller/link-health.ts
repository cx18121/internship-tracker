import type { StoredInternship } from '../lib/types';
import { getInternships, archiveInternshipsByIds, markLinkChecked } from '../lib/store';
import { pool } from '../lib/concurrency';
import { POLLED_SOURCES } from './sources';
import { workdayDetailUrl } from './utils/description-fetchers';

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

/**
 * ATS boards serve a friendly 200 page for a closed job, so HEAD says live
 * when it is not. Ask the ATS API instead where the link shape lets us; the
 * API 404s the moment the job closes.
 */
function atsProbeUrl(url: string): string | null {
  let m = url.match(/greenhouse\.io\/(?:boards\/)?([^/?#]+)\/jobs\/(\d+)/);
  if (m) return `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`;
  m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([a-f0-9-]{36})/);
  if (m) return `https://api.lever.co/v0/postings/${m[1]}/${m[2]}`;
  m = url.match(/ats\.rippling\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/jobs\/([0-9a-f-]+)/i);
  if (m) return `https://api.rippling.com/platform/api/ats/v1/board/${m[1]}/jobs/${m[2]}`;
  m = url.match(/jobs\.smartrecruiters\.com\/([^/?#]+)\/(\d+)/);
  if (m) return `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`;
  return workdayDetailUrl(url);
}

async function ashbyState(url: string): Promise<LinkState> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return GONE_STATUSES.has(res.status) ? 'gone' : 'unknown';
    const html = await res.text();
    // A live posting embeds its data; a closed one renders the board with a notice.
    return /"posting"\s*:\s*\{/.test(html) && !/no longer|isn.t available|has been closed/i.test(html) ? 'live' : 'gone';
  } catch {
    return 'unknown';
  }
}

export async function linkState(url: string): Promise<LinkState> {
  if (/linkedin\.com/.test(url)) return linkedInState(url);
  if (/jobs\.ashbyhq\.com\/[^/]+\/[^/?#]+/.test(url)) return ashbyState(url);
  const probe = atsProbeUrl(url);
  if (probe) {
    try {
      const res = await fetch(probe, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return 'live';
      return GONE_STATUSES.has(res.status) ? 'gone' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  const status = await checkLinkStatus(url);
  if (GONE_STATUSES.has(status)) return 'gone';
  return status === -1 ? 'unknown' : 'live';
}

export function needsCheck(i: StoredInternship, now = Date.now()): boolean {
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
  const run = async (i: StoredInternship) => {
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
  const archived = await archiveInternshipsByIds(gone, 'link gone');
  console.log(`[link-health] checked ${checked.length}/${due.length} feed rows, archived ${archived}, unknown ${unknown}`);
  return { checked: checked.length, archived, unknown };
}
