// Description fetching by ATS — used both by ats.ts (when polling an ATS
// board directly and following up for the per-posting description) and by
// github.ts (when only an apply link is known and we need to dispatch to
// the right ATS based on URL pattern). Before this module, both files
// carried independent copies of the per-ATS extraction logic; the Ashby
// `__appData` regex was duplicated verbatim, the Lever `descriptionPlain`
// fallback was duplicated, and a fix to one would silently miss the other.
//
// Exported in two layers:
//   - `extract*` helpers — pure transforms over an already-fetched response,
//     so ats.ts pollers that already have the data (pollLever's board API
//     ships descriptions inline) don't double-fetch.
//   - `fetch*` functions — perform the HTTP fetch and call the extractor.
//   - `fetchDescriptionByUrl` — URL-based dispatcher used by the SimplifyJobs
//     poller, which only has an apply link.
//
// Workday is not handled here — its fetcher takes (baseHost, tenant, board,
// externalPath) and is called only from ats.ts's pollWorkday. No duplication
// to consolidate.

import axios from 'axios';
import { stripHtml } from './html';

const TIMEOUT_MS = 8000;
// Memory floor on fetched description size. The real storage cap (2000 chars,
// sentence-aware) is applied by smartTrimDescription in agent.ts AFTER scoring,
// so the scorer can see tech keywords from anywhere in the body. This bound
// just prevents a verbose 50KB Workday description from blowing up per-cycle
// memory; under it, everything passes through.
const MAX_DESC_LEN = 20_000;

// ── Pure extractors ────────────────────────────────────────────────────────

/**
 * Extract description from a Lever posting object. Same shape whether the
 * posting came from the board API (`/v0/postings/{slug}`) or the single-
 * posting API (`/v0/postings/{slug}/{id}`).
 */
export function extractLeverDescription(posting: {
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text?: string; content?: string }>;
}): string {
  if (posting?.descriptionPlain) {
    return String(posting.descriptionPlain).slice(0, MAX_DESC_LEN);
  }
  const parts = [
    stripHtml(posting?.description ?? ''),
    ...(posting?.lists ?? []).map(l => `${l.text ?? ''} ${stripHtml(l.content ?? '')}`),
  ];
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC_LEN);
}

/**
 * Extract description from an Ashby job-page HTML. Ashby ships `window.__appData`
 * as inline JSON. The detail page has `data.posting.descriptionHtml`; the board
 * page only has metadata, so descriptions only come from the detail-page form.
 *
 * Accepts trailing newline OR `</script>` after the closing semicolon — the
 * single-newline form is legacy. Without the alternation an Ashby DOM tweak
 * silently zeroes out descriptions across every Ashby tenant.
 */
export function extractAshbyDescription(html: string, jobId: string): string {
  const m = html.match(/window\.__appData\s*=\s*(\{.*?\});\s*(?:\n|<\/script>|$)/s);
  if (!m) {
    console.warn(`[ashby] __appData regex missed for ${jobId} — markup may have changed`);
    return '';
  }
  const data = JSON.parse(m[1]);
  const posting = data?.posting
    ?? data?.jobBoard?.jobPostings?.find((p: { id: string }) => p.id === jobId)
    ?? data?.jobBoard?.jobPostings?.[0];
  return stripHtml(posting?.descriptionHtml ?? '').slice(0, MAX_DESC_LEN);
}

// ── Per-ATS fetchers ───────────────────────────────────────────────────────

export async function fetchGreenhouseDescription(slug: string, jobId: string): Promise<string> {
  try {
    const { data } = await axios.get(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?content=true`,
      { timeout: TIMEOUT_MS },
    );
    return stripHtml(data?.content ?? '').slice(0, MAX_DESC_LEN);
  } catch {
    return '';
  }
}

export async function fetchLeverDescription(slug: string, jobId: string): Promise<string> {
  try {
    const { data } = await axios.get(
      `https://api.lever.co/v0/postings/${slug}/${jobId}?mode=json`,
      { timeout: TIMEOUT_MS },
    );
    return extractLeverDescription(data);
  } catch {
    return '';
  }
}

export async function fetchAshbyDescription(slug: string, jobId: string): Promise<string> {
  try {
    const { data: html } = await axios.get(`https://jobs.ashbyhq.com/${slug}/${jobId}`, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
      responseType: 'text',
    });
    return extractAshbyDescription(html as string, jobId);
  } catch {
    return '';
  }
}

export async function fetchSmartRecruitersDescription(slug: string, jobId: string): Promise<string> {
  try {
    const { data } = await axios.get(
      `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${jobId}`,
      {
        timeout: TIMEOUT_MS,
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      },
    );
    const sections = data?.jobAd?.sections ?? {};
    const parts = [
      sections.companyDescription?.text,
      sections.jobDescription?.text,
      sections.qualifications?.text,
      sections.additionalInformation?.text,
    ].filter(Boolean);
    return stripHtml(parts.join(' ')).slice(0, MAX_DESC_LEN);
  } catch {
    return '';
  }
}

// ── URL dispatcher ─────────────────────────────────────────────────────────

/**
 * Best-effort description fetch by ATS type, given only an apply URL.
 * Returns '' if the URL is from an ATS we don't handle here. Used by the
 * SimplifyJobs poller (github.ts) and any other source that surfaces a
 * direct apply URL without separately fetching the posting.
 */
export async function fetchDescriptionByUrl(url: string): Promise<string> {
  if (!url) return '';

  let m = url.match(/greenhouse\.io\/(?:boards\/)?([^/]+)\/jobs\/(\d+)/);
  if (m) return fetchGreenhouseDescription(m[1], m[2]);

  m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([a-f0-9-]+)/);
  if (m) return fetchLeverDescription(m[1], m[2]);

  m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([^/?#]+)/);
  if (m) return fetchAshbyDescription(m[1], m[2]);

  return '';
}
