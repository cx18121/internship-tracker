import axios from 'axios';
import type { Ats } from './types';
import { TIMEOUT_MS, MAX_DESC_LEN, probe, boardAnswers } from './http';
import { isInternTitle } from '../utils/intern-signal';
import { stripHtml } from '../utils/html';
import { buildPosting } from '../utils/build-row';

interface GreenhouseJob {
  id: number;
  title?: string;
  absolute_url?: string;
  updated_at?: string;
  content?: string;
  location?: { name?: string };
}

const boardApi = (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
const jobApi = (slug: string, id: string) => `${boardApi(slug)}/${id}?content=true`;

/**
 * Links: boards.greenhouse.io/{slug}/jobs/{id}, job-boards.greenhouse.io/{slug}/jobs/{id},
 * boards.greenhouse.io/embed/job_app?token={id}, and company career pages with ?gh_jid={id}
 * (no slug, so only the id is known).
 */
export const greenhouse: Ats = {
  kind: 'greenhouse',
  source: 'Greenhouse',
  matchUrl: (h, p) => h.endsWith('greenhouse.io') || /[?&]gh_jid=\d+/.test(p),
  targetFromUrl: (h, p) => {
    if (!h.endsWith('greenhouse.io')) return null;
    const slug = p.split('/').filter(Boolean)[0];
    return slug && slug !== 'embed' ? { slug, ats: 'greenhouse' } : null;
  },
  jobFromUrl: (url) => {
    const m = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (m && m[1] !== 'embed') return { slug: m[1], jobId: m[2] };
    const id = url.searchParams.get('gh_jid') ?? (url.pathname.includes('/embed/job_app') ? url.searchParams.get('token') : null);
    return id && /^\d+$/.test(id) ? { slug: '', jobId: id } : null;
  },
  boardExists: (slug, timeoutMs) => boardAnswers(boardApi(slug), d => Array.isArray((d as { jobs?: unknown })?.jobs), timeoutMs),
  alive: (job) => (job.slug ? probe(jobApi(job.slug, job.jobId)) : Promise.resolve('unknown')),
  describe: async (job) => {
    if (!job.slug) return '';
    try {
      const { data } = await axios.get<{ content?: string }>(jobApi(job.slug, job.jobId), { timeout: TIMEOUT_MS });
      return stripHtml(data?.content ?? '').slice(0, MAX_DESC_LEN);
    } catch {
      return '';
    }
  },
  poll: async (target, now) => {
    const { data } = await axios.get<{ jobs?: GreenhouseJob[] }>(`${boardApi(target.slug)}?content=true`, { timeout: TIMEOUT_MS });
    const company = target.name || target.slug;
    return (data.jobs ?? [])
      .filter(j => isInternTitle(j.title ?? ''))
      .map(j => buildPosting({
        title: stripHtml(j.title ?? ''),
        company,
        locations: (j.location?.name ?? '').split(';'),
        link: j.absolute_url || `https://boards.greenhouse.io/${target.slug}/jobs/${j.id}`,
        source: 'Greenhouse',
        upstreamPostedAt: j.updated_at,
        now,
        descriptionHtml: j.content,
      }));
  },
};
