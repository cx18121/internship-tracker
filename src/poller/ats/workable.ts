import axios from 'axios';
import type { Ats } from './types';
import { TIMEOUT_MS, JSON_HEADERS } from './http';
import { isInternTitle } from '../utils/intern-signal';
import { buildPosting } from '../utils/build-row';

interface WorkableJob {
  shortcode: string;
  title?: string;
  published?: string;
  remote?: boolean;
  workplace?: string;
  location?: { city?: string; region?: string; country?: string };
}

/** Links: apply.workable.com/{slug}/j/{shortcode}[/apply]. `type` is "temporary" for interns and contractors alike, so titles decide. */
export const workable: Ats = {
  kind: 'workable',
  source: 'Workable',
  matchUrl: (h) => h === 'apply.workable.com',
  targetFromUrl: (_h, p) => {
    const slug = p.split('/').filter(Boolean)[0];
    return slug ? { slug, ats: 'workable' } : null;
  },
  jobFromUrl: (url) => {
    const m = url.pathname.match(/^\/([^/]+)\/j\/([A-Za-z0-9]+)/);
    return m ? { slug: m[1], jobId: m[2].toLowerCase() } : null;
  },
  poll: async (target, now) => {
    const { data } = await axios.post<{ results?: WorkableJob[] }>(`https://apply.workable.com/api/v3/accounts/${target.slug}/jobs`, {}, {
      timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/json', ...JSON_HEADERS },
    });
    const company = target.name || target.slug;
    return (data.results ?? [])
      .filter(j => isInternTitle(j.title ?? ''))
      .map(j => {
        const loc = j.location ?? {};
        const isRemote = j.remote === true || String(j.workplace).toLowerCase() === 'remote';
        return buildPosting({
          title: j.title ?? '',
          company,
          location: loc.city ? [loc.city, loc.region, loc.country].filter(Boolean).join(', ') : (isRemote ? 'Remote' : loc.country ?? ''),
          link: `https://apply.workable.com/${target.slug}/j/${j.shortcode}/`,
          source: 'Workable',
          upstreamPostedAt: j.published,
          now,
        });
      });
  },
};
