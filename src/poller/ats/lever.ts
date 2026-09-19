import axios from 'axios';
import type { Ats } from './types';
import { TIMEOUT_MS, MAX_DESC_LEN, probe, boardAnswers } from './http';
import { isInternTitle } from '../utils/intern-signal';
import { stripHtml } from '../utils/html';
import { buildPosting } from '../utils/build-row';

interface LeverPosting {
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: { commitment?: string; location?: string };
  descriptionPlain?: string;
  description?: string;
  lists?: Array<{ text?: string; content?: string }>;
}

const UUID_RE = /^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const boardApi = (slug: string) => `https://api.lever.co/v0/postings/${slug}?mode=json`;
const jobApi = (slug: string, id: string) => `https://api.lever.co/v0/postings/${slug}/${id}?mode=json`;

/** Same shape from the board API and the single-posting API. */
function extractDescription(p: LeverPosting): string {
  if (p.descriptionPlain) return String(p.descriptionPlain).slice(0, MAX_DESC_LEN);
  const parts = [stripHtml(p.description ?? ''), ...(p.lists ?? []).map(l => `${l.text ?? ''} ${stripHtml(l.content ?? '')}`)];
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC_LEN);
}

/** Links: jobs.lever.co/{slug}/{uuid}[/apply]. */
export const lever: Ats = {
  kind: 'lever',
  source: 'Lever',
  matchUrl: (h) => h === 'jobs.lever.co' || h === 'lever.co',
  targetFromUrl: (_h, p) => {
    const slug = p.split('/').filter(Boolean)[0];
    return slug ? { slug, ats: 'lever' } : null;
  },
  jobFromUrl: (url) => {
    const m = url.pathname.match(UUID_RE);
    return m ? { slug: m[1], jobId: m[2].toLowerCase() } : null;
  },
  boardExists: (slug, timeoutMs) => boardAnswers(boardApi(slug), Array.isArray, timeoutMs),
  alive: (job) => probe(jobApi(job.slug, job.jobId)),
  describe: async (job) => {
    try {
      const { data } = await axios.get<LeverPosting>(jobApi(job.slug, job.jobId), { timeout: TIMEOUT_MS });
      return extractDescription(data);
    } catch {
      return '';
    }
  },
  poll: async (target, now) => {
    const { data } = await axios.get<LeverPosting[]>(boardApi(target.slug), { timeout: TIMEOUT_MS });
    const company = target.name || target.slug;
    return (Array.isArray(data) ? data : [])
      .filter(j => isInternTitle(j.text ?? '') || (j.categories?.commitment ?? '').toLowerCase() === 'internship')
      .map(j => buildPosting({
        title: j.text ?? '',
        company,
        // workplaceType is an enum (remote/onsite/hybrid); only "remote" is a place.
        location: j.categories?.location || (String(j.workplaceType).toLowerCase() === 'remote' ? 'Remote' : ''),
        link: j.hostedUrl || j.applyUrl || '',
        source: 'Lever',
        upstreamPostedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
        now,
        description: extractDescription(j),
      }));
  },
};
