import axios from 'axios';
import type { Ats } from './types';
import { TIMEOUT_MS, MAX_DESC_LEN, JSON_HEADERS, boardAnswers, isGoneStatus } from './http';
import { isInternTitle } from '../utils/intern-signal';
import { stripHtml } from '../utils/html';
import { buildPosting } from '../utils/build-row';

interface AshbyJob {
  id: string;
  title: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  isRemote?: boolean | null;
  publishedAt?: string;
  jobUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
}

const UUID_RE = /^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * The board page at jobs.ashbyhq.com is a client-rendered shell; every read
 * goes through the public posting API, which returns the whole board with
 * descriptions in one call. Links: jobs.ashbyhq.com/{slug}/{uuid}[/application].
 */
const boardApi = (slug: string) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`;

async function fetchBoard(slug: string): Promise<AshbyJob[]> {
  const { data } = await axios.get<{ jobs?: AshbyJob[] }>(boardApi(slug), { timeout: TIMEOUT_MS, headers: JSON_HEADERS });
  return data.jobs ?? [];
}

export const ashby: Ats = {
  kind: 'ashby',
  source: 'Ashby',
  matchUrl: (h) => h === 'jobs.ashbyhq.com',
  targetFromUrl: (_h, p) => {
    const slug = p.split('/').filter(Boolean)[0];
    return slug ? { slug, ats: 'ashby' } : null;
  },
  jobFromUrl: (url) => {
    const m = url.pathname.match(UUID_RE);
    return m ? { slug: m[1], jobId: m[2].toLowerCase() } : null;
  },
  boardExists: (slug, timeoutMs) => boardAnswers(boardApi(slug), d => Array.isArray((d as { jobs?: unknown })?.jobs), timeoutMs),
  alive: async (job) => {
    try {
      const res = await fetch(boardApi(job.slug), { headers: JSON_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (isGoneStatus(res.status)) return 'gone';
      if (!res.ok) return 'unknown';
      const data = (await res.json()) as { jobs?: Array<{ id: string }> };
      return data.jobs?.some(j => j.id.toLowerCase() === job.jobId) ? 'live' : 'gone';
    } catch {
      return 'unknown';
    }
  },
  describe: async (job) => {
    try {
      const j = (await fetchBoard(job.slug)).find(x => x.id.toLowerCase() === job.jobId);
      return (j?.descriptionPlain ?? stripHtml(j?.descriptionHtml ?? '')).slice(0, MAX_DESC_LEN);
    } catch {
      return '';
    }
  },
  poll: async (target, now) => {
    const company = target.name || target.slug;
    return (await fetchBoard(target.slug))
      .filter(j => isInternTitle(j.title ?? '') || /intern/i.test(j.employmentType ?? ''))
      .map(j => buildPosting({
        title: j.title ?? '',
        company,
        locations: [j.location, ...(j.secondaryLocations ?? []).map(l => l.location), j.isRemote ? 'Remote' : undefined],
        link: j.jobUrl || `https://jobs.ashbyhq.com/${target.slug}/${j.id}`,
        source: 'Ashby',
        upstreamPostedAt: j.publishedAt,
        now,
        description: j.descriptionPlain,
        descriptionHtml: j.descriptionPlain ? undefined : j.descriptionHtml,
      }));
  },
};
