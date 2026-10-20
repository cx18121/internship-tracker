import captured from '../fixtures/same-day-openings.json';
import { linkedInDetails } from '../../src/poller/ats/linkedin';
import type { StoredInternship } from '../../src/lib/types';

export function sameDayCase(name: string): StoredInternship[] {
  const found = captured.cases.find(c => c.name === name);
  if (!found) throw new Error(`Unknown captured case: ${name}`);
  return structuredClone(found.rows) as StoredInternship[];
}
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Replay a new source observation, without rewriting another retained alias. */
export function observeLinkedIn(r: StoredInternship): StoredInternship {
  const old = r.identities![0];
  if (!old.postingKey.startsWith('linkedin:post:')) throw new Error('Expected a captured LinkedIn observation');
  const html = `<h2>${escapeHtml(old.title)}</h2><a data-tracking-control-name="public_jobs_topcard-org-name" href="${old.employer?.reference}">${r.company}</a><div class="show-more-less-html__markup">${escapeHtml(r.description ?? '').replace(/\n/g, '<br>')}</div>`;
  const identity = linkedInDetails(html, old.postingKey.split(':').at(-1)!).identity!;
  return { ...r, identities: [{ ...identity, origin: 'feed', employer: identity.employer ?? old.employer }] };
}
