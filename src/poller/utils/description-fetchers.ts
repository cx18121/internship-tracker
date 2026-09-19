// Description fetching by ATS, used by ats.ts (polling a board directly) and
// github.ts (dispatching on an apply link's URL pattern).
//
// Exported in two layers:
//   - `extract*` helpers — pure transforms over an already-fetched response,
//     so ats.ts pollers that already have the data (pollLever's board API
//     ships descriptions inline) don't double-fetch.
//   - `fetch*` functions — perform the HTTP fetch and call the extractor.
//   - `fetchDescriptionByUrl` — URL-based dispatcher used by the SimplifyJobs
//     poller, which only has an apply link.
//

import axios from 'axios';
import { stripHtml } from './html';
import { extractLinkedInJobId } from '../link-health';

const TIMEOUT_MS = 8000;
const MAX_DESC_LEN = 6_000;

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
    const { data } = await axios.get<{ jobs?: Array<{ id: string; descriptionPlain?: string; descriptionHtml?: string }> }>(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}`, { timeout: TIMEOUT_MS, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } },
    );
    const job = data?.jobs?.find(j => j.id === jobId);
    return (job?.descriptionPlain ?? stripHtml(job?.descriptionHtml ?? '')).slice(0, MAX_DESC_LEN);
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

export async function fetchRipplingDescription(slug: string, jobId: string): Promise<string> {
  try {
    const { data } = await axios.get(
      `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs/${jobId}`,
      {
        timeout: TIMEOUT_MS,
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      },
    );
    // description is { company, role } HTML — `role` is the job-specific body;
    // `company` is shared boilerplate. Keep role first so the scorer sees
    // role-specific keywords before the company blurb.
    const d = data?.description ?? {};
    const parts = [d.role, d.company].filter(Boolean);
    return stripHtml(parts.join(' ')).slice(0, MAX_DESC_LEN);
  } catch {
    return '';
  }
}

/**
 * Workday public job URLs look like
 *   https://{tenant}.{wd}.myworkdayjobs.com/[{locale}/]{board}/job/{location}/{slug}_{req}
 *   https://{wd}.myworkdaysite.com/recruiting/{tenant}/{board}/job/...
 * The CXS detail endpoint is /wday/cxs/{tenant}/{board}/job/{location}/{slug}_{req}.
 */
export function workdayDetailUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname;
  const parts = u.pathname.split('/').filter(Boolean);
  const jobIdx = parts.indexOf('job');
  if (jobIdx < 0) return null;
  let tenant: string | undefined;
  let board: string | undefined;
  if (host.endsWith('.myworkdayjobs.com')) {
    tenant = host.split('.')[0];
    // optional locale segment (en-US) before the board
    const before = parts.slice(0, jobIdx).filter(p => !/^[a-z]{2}-[A-Z]{2}$/.test(p));
    board = before[before.length - 1];
  } else if (host.endsWith('.myworkdaysite.com') && parts[0] === 'recruiting') {
    tenant = parts[1];
    board = parts[jobIdx - 1];
  }
  if (!tenant || !board) return null;
  return `https://${host}/wday/cxs/${tenant}/${board}/${parts.slice(jobIdx).join('/')}`;
}

export interface WorkdayDetail {
  description: string;
  /** Real location list; empty when the detail call fails. */
  locations: string[];
}

export async function fetchWorkdayDetailByUrl(url: string): Promise<WorkdayDetail> {
  const detail = workdayDetailUrl(url);
  if (!detail) return { description: '', locations: [] };
  try {
    const { data } = await axios.get<{ jobPostingInfo?: { jobDescription?: string; location?: string; additionalLocations?: string[] } }>(
      detail, { timeout: TIMEOUT_MS, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } },
    );
    const info = data?.jobPostingInfo;
    return {
      description: stripHtml(info?.jobDescription ?? '').slice(0, MAX_DESC_LEN),
      locations: info?.location ? [info.location, ...(info.additionalLocations ?? [])] : [],
    };
  } catch {
    return { description: '', locations: [] };
  }
}

export async function fetchWorkdayDescriptionByUrl(url: string): Promise<string> {
  return (await fetchWorkdayDetailByUrl(url)).description;
}

/** LinkedIn's guest job endpoint serves the JD server-side without auth. */
export async function fetchLinkedInDescription(url: string): Promise<string> {
  const id = extractLinkedInJobId(url);
  if (!id) return '';
  try {
    const { data: html } = await axios.get<string>(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
      timeout: TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' }, responseType: 'text',
    });
    const m = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/);
    return m ? stripHtml(m[1]).slice(0, MAX_DESC_LEN) : '';
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

  // ats.rippling.com/[locale/]{slug}/jobs/{uuid}
  m = url.match(/ats\.rippling\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/jobs\/([0-9a-f-]+)/i);
  if (m) return fetchRipplingDescription(m[1], m[2]);

  m = url.match(/jobs\.smartrecruiters\.com\/([^/?#]+)\/(\d+)/);
  if (m) return fetchSmartRecruitersDescription(m[1], m[2]);

  if (/myworkday(jobs|site)\.com/.test(url)) return fetchWorkdayDescriptionByUrl(url);
  if (/linkedin\.com/.test(url)) return fetchLinkedInDescription(url);

  return '';
}
