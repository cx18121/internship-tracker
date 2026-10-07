import type { RawPosting } from '../lib/types';
import { getPostingIdentities } from '../lib/store';
import { roleSignature } from '../lib/opportunity';
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
