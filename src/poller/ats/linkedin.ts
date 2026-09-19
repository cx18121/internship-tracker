import axios from 'axios';
import type { LinkHandler } from './types';
import { TIMEOUT_MS, MAX_DESC_LEN, HTML_HEADERS, isGoneStatus } from './http';
import { stripHtml } from '../utils/html';

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
  describe: async (job) => {
    try {
      const { data: html } = await axios.get<string>(guestApi(job.jobId), { timeout: TIMEOUT_MS, headers: HTML_HEADERS, responseType: 'text' });
      const m = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/);
      return m ? stripHtml(m[1]).slice(0, MAX_DESC_LEN) : '';
    } catch {
      return '';
    }
  },
};
