import type { LinkState } from './types';

export const TIMEOUT_MS = 10_000;
export const MAX_DESC_LEN = 6_000;
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';
export const JSON_HEADERS = { Accept: 'application/json', 'User-Agent': UA };
export const HTML_HEADERS = { Accept: 'text/html', 'User-Agent': UA };

const GONE_STATUSES = new Set([401, 404, 410, 451]);

export const isGoneStatus = (status: number): boolean => GONE_STATUSES.has(status);

export const LOCALE_RE = /^[a-z]{2}[-_][A-Z]{2}$/i;

/** First path segment that is not a locale like en-US. */
export const firstSegment = (pathname: string): string | undefined =>
  pathname.split('/').filter(Boolean).find(seg => !LOCALE_RE.test(seg));

/** Liveness from an ATS API endpoint that 404s once the job closes. */
export async function probe(url: string): Promise<LinkState> {
  try {
    const res = await fetch(url, { headers: JSON_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return 'live';
    return isGoneStatus(res.status) ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Does a board API answer with a job list for this slug? */
export async function boardAnswers(url: string, isList: (data: unknown) => boolean, timeoutMs = TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: JSON_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 200 && isList(await res.json());
  } catch {
    return false;
  }
}
