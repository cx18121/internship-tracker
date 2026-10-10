import type { RawPosting, StoredInternship, PostingIdentity } from '../lib/types';
import { getPostingIdentities, getIdentityCandidates, saveExistingIdentities } from '../lib/store';
import { roleSignature, plausibleRole, employerNames } from '../lib/opportunity';
import { parseSeason } from '../lib/seasons';
import { detailsByUrl, postingKey, ATS_SOURCES } from './ats';
import { pool } from '../lib/concurrency';

export function hasCurrentIdentity(identity: PostingIdentity): boolean {
  if (identity.postingKey.startsWith('amazon:')) return !!identity.requisitionKey && !!identity.employer && !!identity.title;
  if (identity.postingKey.startsWith('workday:') && !identity.requisitionKey) return false;
  return identity.facts?.version === 1 && (identity.origin === 'board' || !!identity.employer) &&
    (!identity.postingKey.startsWith('linkedin:') || identity.version === 1);
}

function acceptIdentity(p: RawPosting, identity: PostingIdentity, resolved = false): void {
  p.identity = { ...identity, title: identity.title || p.title };
  if (resolved || (identity.origin === 'board' && !ATS_SOURCES.includes(p.source))) {
    // Same physical posting, not company/title inference. Employer-owned
    // metadata controls labels used for classification and alerting.
    p.title = p.identity.title;
    p.explicitTerms = identity.terms;
    p.season = identity.terms.some(t => !t.startsWith('year-')) ? identity.terms.filter(t => !t.startsWith('year-')) : undefined;
    p.openingFacts = identity.facts;
  }
}

/** Reuse native posting evidence, then fetch missing supported identity evidence before alerts.
 * Failed or capped lookups keep the posting and its immediate alert. */
export async function enrichPostingIdentities(postings: RawPosting[], cap = 300): Promise<void> {
  const pending = postings.filter(p => !p.identity && !postingKey(p.link).startsWith('url:'));
  if (!pending.length) return;
  const known = await getPostingIdentities(pending.map(p => postingKey(p.link)), pending.map(p => p.link));
  const missing = new Map<string, RawPosting[]>();
  for (const p of pending) {
    const key = postingKey(p.link);
    const cached = known.get(key);
    const resolvedBoard = /^greenhouse:_:post:\d+$/.test(key) && cached && cached.postingKey !== key;
    const authoritative = cached?.origin === 'board' && !ATS_SOURCES.includes(p.source);
    if (cached && hasCurrentIdentity(cached) && (resolvedBoard || authoritative || (roleSignature(cached.title) === roleSignature(p.title) &&
        JSON.stringify(parseSeason(cached.title)) === JSON.stringify(parseSeason(p.title))))) {
      acceptIdentity(p,cached,!!resolvedBoard);
    } else {
      missing.set(key, [...missing.get(key) ?? [], p]);
    }
  }
  await pool([...missing.values()].slice(0, cap), 4, async group => {
    const detail = await detailsByUrl(group[0].link);
    for (const p of group) {
      if (detail.identity) acceptIdentity(p,detail.identity);
      if (!p.description && detail.description) p.description = detail.description;
    }
  });
}

/** Resolve historical source observations, not canonicalized display names.
 * Successful updates attach to existing IDs and can never become new alerts. */
export async function enrichStoredPostingIdentities(rows: StoredInternship[], cap = 300, observed: PostingIdentity[] = []): Promise<void> {
  const current = new Map(observed.filter(hasCurrentIdentity).map(x => [x.postingKey, x]));
  const raw: RawPosting[] = rows.map(i => ({ title: i.title, company: i.company, locations: i.locations, link: i.link,
    source: i.source, description: i.description, companyObserved: false, identity: current.get(postingKey(i.link)) }));
  await enrichPostingIdentities(raw, cap);
  await saveExistingIdentities(raw.flatMap((p, n) => p.identity ? [{ id: rows[n].id, identities: [p.identity], description: p.description }] : []));
}

/** Prepare likely historical counterparts before deciding which current observations are new.
 * Company/title only select URLs to inspect; fetched source evidence owns matching. */
export async function prepareStoredIdentityCandidates(incoming: StoredInternship[], cap = 300): Promise<void> {
  const candidates = await getIdentityCandidates([...new Set(incoming.map(i => i.company))],
    incoming.flatMap(i => (i.identities ?? []).flatMap(employerNames)));
  const missing = candidates.filter(i => !postingKey(i.link).startsWith('url:') &&
    !i.identities?.some(x => x.postingKey === postingKey(i.link) && hasCurrentIdentity(x)) &&
    incoming.some(p => plausibleRole(p.title, i.title) &&
      p.identities?.some(x => !i.identities?.some(y => y.postingKey === x.postingKey))));
  await enrichStoredPostingIdentities(missing, cap, incoming.flatMap(i => i.identities ?? []));
}
