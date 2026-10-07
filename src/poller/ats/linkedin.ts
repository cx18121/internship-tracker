import type { LinkHandler, PostingDetails } from './types';
import { openingFacts, explicitInternshipTerms } from '../../lib/opportunity';
import { TIMEOUT_MS, MAX_DESC_LEN, HTML_HEADERS, isGoneStatus } from './http';
import { stripHtml, decodeHtmlEntities, identityText } from '../utils/html';

/**
 * LinkedIn is a feed, not a board we poll. Its guest endpoint serves the JD
 * and a closed marker without auth; the external apply link is only served
 * to signed-in sessions. Links: linkedin.com/jobs/view/[title-]{id} and
 * linkedin.com/jobs/search/?currentJobId={id}.
 */
const guestApi = (id: string) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;

export function linkedInJobId(url: URL): string | null {
  const cur = url.searchParams.get('currentJobId');
  if (cur && /^\d+$/.test(cur)) return cur;
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  return last.match(/(\d+)$/)?.[1] ?? null;
}

/** The employer link on this posting, not a related employer elsewhere on the page. */
export function linkedInDetails(html: string, id: string): PostingDetails {
  const markup = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  const full = identityText(markup);
  const title = stripHtml(html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '');
  const employerTag = html.match(/<a\b[^>]*data-tracking-control-name=["']public_jobs_topcard-org-name["'][^>]*>/)?.[0];
  const href = employerTag?.match(/href=["']([^"']+)["']/)?.[1];
  let employer: NonNullable<NonNullable<PostingDetails['identity']>['employer']> | undefined;
  try {
    const url = new URL(decodeHtmlEntities(href ?? ''));
    const handle = url.pathname.match(/^\/company\/([^/]+)\/?$/)?.[1];
    if (handle && /^(www\.)?linkedin\.com$/.test(url.hostname)) employer = {
      name: decodeURIComponent(handle), reference: `https://www.linkedin.com/company/${handle}`, kind: 'linkedin',
    };
  } catch { /* Missing/blocked employer evidence means no cross-name merge. */ }
  return { description: full.slice(0, MAX_DESC_LEN), ...(title ? { identity: {
    postingKey: `linkedin:post:${id}`,
    sourceUrl: `https://www.linkedin.com/jobs/search/?currentJobId=${id}`,
    title, terms: explicitInternshipTerms(title, full), employer, facts: openingFacts(full),
  } } : {}) };
}

export const linkedin: LinkHandler = {
  matchUrl: (h) => h.endsWith('linkedin.com'),
  jobFromUrl: (url) => {
    const id = linkedInJobId(url);
    return id ? { slug: 'linkedin', jobId: id } : null;
  },
  alive: async (job) => {
    try {
      const res = await fetch(guestApi(job.jobId), { headers: HTML_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (isGoneStatus(res.status)) return 'gone';
      if (!res.ok) return 'unknown';
      const html = await res.text();
      return /closed-job__flavor--closed|No longer accepting applications/i.test(html) ? 'gone' : 'live';
    } catch {
      return 'unknown';
    }
  },
  details: async (job) => {
    try {
      const res = await fetch(guestApi(job.jobId), { headers: HTML_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok ? linkedInDetails(await res.text(), job.jobId) : { description: '' };
    } catch { return { description: '' }; }
  },
};
