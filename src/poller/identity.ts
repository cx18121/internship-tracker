import type { RawPosting, StoredInternship, PostingIdentity } from '../lib/types';
import { getPostingIdentities, getIdentityCandidates, saveExistingIdentities } from '../lib/store';
import { roleSignature, plausibleRole } from '../lib/opportunity';
import { parseSeason } from '../lib/seasons';
import { detailsByUrl, postingKey } from './ats';
import { pool } from '../lib/concurrency';

/** Fetch only missing Greenhouse/LinkedIn identity evidence, before storage and alerts.
 * Failed or capped lookups keep the posting and its immediate alert. */
export async function enrichPostingIdentities(postings: RawPosting[], cap = 300): Promise<void> {
  const pending = postings.filter(p => !p.identity && /^(greenhouse|linkedin):/.test(postingKey(p.link)));
  if (!pending.length) return;
  const known = await getPostingIdentities(pending.map(p => postingKey(p.link)));
  const missing = new Map<string, RawPosting[]>();
  for (const p of pending) {
    const key = postingKey(p.link);
    const cached = known.get(key);
    if (cached?.facts?.version === 1 && cached.employer && roleSignature(cached.title) === roleSignature(p.title) &&
        JSON.stringify(parseSeason(cached.title)) === JSON.stringify(parseSeason(p.title))) {
      p.identity = cached;
    } else {
      missing.set(key, [...missing.get(key) ?? [], p]);
    }
  }
  await pool([...missing.values()].slice(0, cap), 4, async group => {
    const detail = await detailsByUrl(group[0].link);
    for (const p of group) {
      if (detail.identity) p.identity = detail.identity;
      if (!p.description && detail.description) p.description = detail.description;
    }
  });
}

/** Resolve historical source observations, not canonicalized display names.
 * Successful updates attach to existing IDs and can never become new alerts. */
export async function enrichStoredPostingIdentities(rows: StoredInternship[], cap = 300, observed: PostingIdentity[] = []): Promise<void> {
  const current = new Map(observed.filter(x => x.employer && x.facts?.version === 1).map(x => [x.postingKey, x]));
  const raw: RawPosting[] = rows.map(i => ({ title: i.title, company: i.company, locations: i.locations, link: i.link,
    source: i.source, description: i.description, companyObserved: false, identity: current.get(postingKey(i.link)) }));
  await enrichPostingIdentities(raw, cap);
  await saveExistingIdentities(raw.flatMap((p, n) => p.identity ? [{ id: rows[n].id, identities: [p.identity], description: p.description }] : []));
}

/** Prepare likely historical counterparts before deciding which current observations are new.
 * Company/title only select URLs to inspect; fetched source evidence owns matching. */
export async function prepareStoredIdentityCandidates(incoming: StoredInternship[], cap = 300): Promise<void> {
  const candidates = await getIdentityCandidates([...new Set(incoming.map(i => i.company))]);
  const missing = candidates.filter(i => /^(greenhouse|linkedin):/.test(postingKey(i.link)) &&
    !i.identities?.some(x => x.postingKey === postingKey(i.link) && x.employer && x.facts?.version === 1) &&
    incoming.some(p => p.company === i.company && plausibleRole(p.title, i.title) &&
      p.identities?.some(x => !i.identities?.some(y => y.postingKey === x.postingKey))));
  await enrichStoredPostingIdentities(missing, cap, incoming.flatMap(i => i.identities ?? []));
}
