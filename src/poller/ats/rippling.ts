import axios from 'axios';
import type { Ats } from './types';
import { TIMEOUT_MS, MAX_DESC_LEN, JSON_HEADERS, probe, firstSegment } from './http';
import { isInternTitle } from '../utils/intern-signal';
import { stripHtml } from '../utils/html';
import { buildPosting } from '../utils/build-row';
import { pool } from '../../lib/concurrency';

interface RipplingJob {
  uuid: string;
  name?: string;
  url?: string;
  workLocation?: { label?: string };
}

const boardApi = (slug: string) => `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`;
const jobApi = (slug: string, id: string) => `${boardApi(slug)}/${id}`;

async function describe(slug: string, id: string): Promise<string> {
  try {
    const { data } = await axios.get(jobApi(slug, id), { timeout: TIMEOUT_MS, headers: JSON_HEADERS });
    // description is { company, role } HTML; role first so the job-specific text leads.
    const d = data?.description ?? {};
    return stripHtml([d.role, d.company].filter(Boolean).join(' ')).slice(0, MAX_DESC_LEN);
  } catch {
    return '';
  }
}

/** Links: ats.rippling.com/[{locale}/]{slug}/jobs/{uuid}. The board lists one entry per location. */
export const rippling: Ats = {
  kind: 'rippling',
  source: 'Rippling',
  matchUrl: (h) => h === 'ats.rippling.com',
  targetFromUrl: (_h, p) => {
    const slug = firstSegment(p);
    return slug ? { slug, ats: 'rippling' } : null;
  },
  jobFromUrl: (url) => {
    const m = url.pathname.match(/\/([^/]+)\/jobs\/([0-9a-f-]{36})/i);
    return m ? { slug: m[1], jobId: m[2].toLowerCase() } : null;
  },
  alive: (job) => probe(jobApi(job.slug, job.jobId)),
  describe: (job) => describe(job.slug, job.jobId),
  poll: async (target, now) => {
    const { data } = await axios.get<RipplingJob[]>(boardApi(target.slug), { timeout: TIMEOUT_MS, headers: JSON_HEADERS });
    const company = target.name || target.slug;
    const byUuid = new Map<string, { job: RipplingJob; locations: string[] }>();
    for (const j of Array.isArray(data) ? data : []) {
      if (!isInternTitle(j.name ?? '')) continue;
      const loc = j.workLocation?.label;
      const entry = byUuid.get(j.uuid) ?? { job: j, locations: [] };
      if (loc && !entry.locations.includes(loc)) entry.locations.push(loc);
      byUuid.set(j.uuid, entry);
    }
    const grouped = [...byUuid.values()];
    const descriptions = new Map<string, string>();
    await pool(grouped, 5, async ({ job }) => { descriptions.set(job.uuid, await describe(target.slug, job.uuid)); });
    return grouped.map(({ job, locations }) => buildPosting({
      title: job.name ?? '',
      company,
      locations,
      link: job.url || `https://ats.rippling.com/${target.slug}/jobs/${job.uuid}`,
      source: 'Rippling',
      now,
      description: descriptions.get(job.uuid),
    }));
  },
};
