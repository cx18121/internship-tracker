import type { LinkHandler } from './types';
import { explicitInternshipTerms } from '../../lib/opportunity';

/** Amazon's employer-issued job ID. LinkedIn prefixes this same ID with A. */
export function amazonRequisitionKey(id: string): string {
  return `amazon:amazon:req:${id}`;
}

/** Link identity only. No additional board polling or source is introduced. */
export const amazon: LinkHandler = {
  kind: 'amazon',
  matchUrl: h => /^(?:www\.)?amazon\.jobs$/.test(h),
  jobFromUrl: url => {
    const id = url.pathname.match(/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?jobs\/(\d+)(?:\/|$)/)?.[1];
    return id ? { slug: 'amazon', jobId: id } : null;
  },
  details: async (job, sourceUrl) => ({ description: '', identity: {
    postingKey: `amazon:amazon:post:${job.jobId}`, sourceUrl, title: '',
    terms: explicitInternshipTerms(new URL(sourceUrl).pathname.replace(/-/g, ' ')),
    requisitionKey: amazonRequisitionKey(job.jobId),
    employer: { name: 'Amazon', reference: sourceUrl, kind: 'source' },
  } }),
};
