import axios from 'axios';
import type { Ats } from './types';
import { TIMEOUT_MS, MAX_DESC_LEN, JSON_HEADERS, probe } from './http';
import { isInternTitle } from '../utils/intern-signal';
import { stripHtml } from '../utils/html';
import { buildPosting } from '../utils/build-row';

interface SmartRecruitersPosting {
  id: string;
  name?: string;
  releasedDate?: string;
  typeOfEmployment?: { id?: string };
  location?: { city?: string; region?: string; country?: string };
}

const jobApi = (slug: string, id: string) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`;

async function describe(slug: string, id: string): Promise<string> {
  try {
    const { data } = await axios.get(jobApi(slug, id), { timeout: TIMEOUT_MS, headers: JSON_HEADERS });
    const s = data?.jobAd?.sections ?? {};
    const parts = [s.companyDescription?.text, s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text].filter(Boolean);
    return stripHtml(parts.join(' ')).slice(0, MAX_DESC_LEN);
  } catch {
    return '';
  }
}

/** Links: jobs.smartrecruiters.com/{slug}/{id}[-title]. */
export const smartrecruiters: Ats = {
  kind: 'smartrecruiters',
  source: 'SmartRecruiters',
  matchUrl: (h) => h === 'jobs.smartrecruiters.com',
  targetFromUrl: (_h, p) => {
    const slug = p.split('/').filter(Boolean)[0];
    return slug ? { slug, ats: 'smartrecruiters' } : null;
  },
  jobFromUrl: (url) => {
    const m = url.pathname.match(/^\/([^/]+)\/(\d+)/);
    return m ? { slug: m[1], jobId: m[2] } : null;
  },
  alive: (job) => probe(jobApi(job.slug, job.jobId)),
  describe: (job) => describe(job.slug, job.jobId),
  poll: async (target, now) => {
    const { data } = await axios.get<{ content?: SmartRecruitersPosting[] }>(
      `https://api.smartrecruiters.com/v1/companies/${target.slug}/postings?status=PUBLIC&limit=100`,
      { timeout: TIMEOUT_MS, headers: JSON_HEADERS },
    );
    const company = target.name || target.slug;
    const interns = (data.content ?? []).filter(j => isInternTitle(j.name ?? '') || /intern/i.test(j.typeOfEmployment?.id ?? ''));
    const results = [];
    for (const j of interns) {
      results.push(buildPosting({
        title: j.name ?? '',
        company,
        location: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', ') || 'United States',
        link: `https://jobs.smartrecruiters.com/${target.slug}/${j.id}`,
        source: 'SmartRecruiters',
        upstreamPostedAt: j.releasedDate,
        now,
        description: await describe(target.slug, j.id),
      }));
    }
    return results;
  },
};
