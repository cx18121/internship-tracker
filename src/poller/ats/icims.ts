import axios from 'axios';
import type { Ats } from './types';
import { TIMEOUT_MS, HTML_HEADERS } from './http';
import { isInternTitle } from '../utils/intern-signal';
import { buildPosting } from '../utils/build-row';
import type { RawPosting } from '../../lib/types';

/** Links: careers-{slug}.icims.com/jobs/{id}/... HTML only; the list page has no location or description. */
export const icims: Ats = {
  kind: 'icims',
  source: 'iCIMS',
  matchUrl: (h) => h.endsWith('.icims.com'),
  targetFromUrl: (h) => {
    const sub = h.replace('.icims.com', '');
    const slug = sub.startsWith('careers-') ? sub.slice('careers-'.length) : sub;
    return slug ? { slug, ats: 'icims' } : null;
  },
  jobFromUrl: (url) => {
    const m = url.pathname.match(/\/jobs\/(\d+)\//);
    const slug = url.hostname.replace('.icims.com', '').replace(/^careers-/, '');
    return m ? { slug, jobId: m[1] } : null;
  },
  poll: async (target, now) => {
    const tenantId = target.slug;
    const { data: html } = await axios.get<string>(
      `https://careers-${tenantId}.icims.com/jobs/search?ss=1&searchKeyword=intern&searchLocation=&in_iframe=1`,
      { timeout: TIMEOUT_MS, headers: HTML_HEADERS, responseType: 'text' },
    );
    const company = target.name || tenantId;
    const results: RawPosting[] = [];
    const itemPattern = /<li[^>]*class="[^"]*iCIMS_JobsTable_Item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    const linkPattern = /href="([^"]*\/jobs\/(\d+)\/[^"]*)"[^>]*>\s*(.*?)\s*<\/a>/i;
    for (const item of html.matchAll(itemPattern)) {
      const link = linkPattern.exec(item[1]);
      if (!link) continue;
      const [, relLink, jobId, rawTitle] = link;
      const title = rawTitle.replace(/<[^>]+>/g, '').trim();
      if (!isInternTitle(title)) continue;
      results.push(buildPosting({
        title,
        company,
        location: 'United States',
        link: relLink.startsWith('http') ? relLink : `https://careers-${tenantId}.icims.com/jobs/${jobId}/job`,
        source: 'iCIMS',
        now,
      }));
    }
    return results;
  },
};
