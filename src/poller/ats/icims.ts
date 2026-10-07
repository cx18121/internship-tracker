import type { LinkHandler } from './types';

/** Keep identities for iCIMS links discovered through feeds; direct polling is retired. */
export const icims: LinkHandler = {
  kind: 'icims',
  matchUrl: (h) => h.endsWith('.icims.com'),
  jobFromUrl: (url) => {
    const m = url.pathname.match(/\/jobs\/(\d+)\//);
    const slug = url.hostname.replace('.icims.com', '').replace(/^careers-/, '');
    return m ? { slug, jobId: m[1] } : null;
  },
};
