/**
 * Registry of hiring systems. Each ATS module owns everything the tracker
 * knows about it (URL shapes, board and job APIs, polling, descriptions,
 * liveness); this file only dispatches on a link.
 */
import type { ATSTarget } from '../../lib/types';
import type { Ats, ATSKind, JobRef, LinkHandler, LinkState } from './types';
import { greenhouse } from './greenhouse';
import { lever } from './lever';
import { ashby } from './ashby';
import { workday } from './workday';
import { icims } from './icims';
import { smartrecruiters } from './smartrecruiters';
import { rippling } from './rippling';
import { workable } from './workable';
import { linkedin } from './linkedin';
import { isGoneStatus, UA } from './http';

export type { Ats, ATSKind, JobRef, LinkHandler, LinkState } from './types';

export const ATS: Record<ATSKind, Ats> = { greenhouse, lever, ashby, workday, icims, smartrecruiters, rippling, workable };

/** Source labels the ATS pollers write. */
export const ATS_SOURCES: readonly string[] = Object.values(ATS).map(a => a.source);

const HANDLERS: readonly LinkHandler[] = [...Object.values(ATS), linkedin];

function parse(link: string): URL | null {
  try { return new URL(link); } catch { return null; }
}

function handlerFor(url: URL): LinkHandler | null {
  const h = url.hostname.toLowerCase();
  const p = url.pathname.toLowerCase() + url.search.toLowerCase();
  return HANDLERS.find(x => x.matchUrl(h, p)) ?? null;
}

function atsFor(url: URL): Ats | null {
  const h = url.hostname.toLowerCase();
  const p = url.pathname.toLowerCase() + url.search.toLowerCase();
  return Object.values(ATS).find(a => a.matchUrl(h, p)) ?? null;
}

/** Board descriptor for a link, with the caller's display name. */
export function discoverATSTarget(link: string, companyName: string): ATSTarget | null {
  const url = parse(link);
  const ats = url && atsFor(url);
  const target = ats?.targetFromUrl(url!.hostname.toLowerCase(), url!.pathname);
  return target ? { ...target, name: companyName } : null;
}

/**
 * Stable identity of a posting across links to the same job, so slug case,
 * embed flags, and /application suffixes collapse to one row. Unknown hosts
 * fall back to the lower-cased URL minus hash and trailing slash; the query
 * string stays because some career sites keep the job id there.
 */
export function jobKey(link: string): string {
  const url = parse(link);
  if (url) {
    const handler = handlerFor(url);
    const job = handler?.jobFromUrl(url);
    if (handler && job) {
      const kind = (handler as Ats).kind ?? 'linkedin';
      return `${kind}:${job.jobId.toLowerCase()}`;
    }
  }
  return link.toLowerCase().replace(/#.*$/, '').replace(/\/+(\?|$)/, '$1');
}

/** Job description for a link, '' when the system is unknown or the fetch fails. */
export async function describeByUrl(link: string): Promise<string> {
  const url = parse(link);
  if (!url) return '';
  const handler = handlerFor(url);
  const job = handler?.jobFromUrl(url);
  return handler?.describe && job ? handler.describe(job, link) : '';
}

/** HTTP status of a HEAD request (GET on HEAD error); -1 on network error or timeout. */
export async function checkLinkStatus(url: string, timeoutMs = 8000): Promise<number> {
  const attempt = async (method: 'HEAD' | 'GET'): Promise<number> =>
    (await fetch(url, { method, redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })).status;
  try {
    return await attempt('HEAD');
  } catch {
    return attempt('GET').catch(() => -1);
  }
}

/**
 * Whether a posting still exists. Boards serve a friendly 200 page for a
 * closed job, so systems with an API answer through it; anything else falls
 * back to the HTTP status.
 */
export async function linkState(link: string): Promise<LinkState> {
  const url = parse(link);
  if (url) {
    const handler = handlerFor(url);
    const job = handler?.jobFromUrl(url);
    if (handler?.alive && job) return handler.alive(job, link);
  }
  const status = await checkLinkStatus(link);
  if (isGoneStatus(status)) return 'gone';
  return status === -1 ? 'unknown' : 'live';
}

/** Does a public board exist for this slug? Used by discovery. */
export function verifyAtsSlug(slug: string, kind: ATSKind, timeoutMs?: number): Promise<boolean> {
  const check = ATS[kind].boardExists;
  return check ? check(slug, timeoutMs) : Promise.resolve(false);
}
