import { createHash } from 'node:crypto';
import type { StoredInternship, RawPosting } from '../../lib/types';
import { stripUtm, stripEmojiPrefix } from '../../lib/utils/normalize';
import { parseSalary } from '../../lib/salary';
import { normalizeKey } from '../../lib/normalize-key';
import { canonicalizeCompany } from '../../lib/canonicalize-company';
import { deriveSeasonWithDefault, openSeasonTokens } from '../../lib/seasons';

/**
 * Promote a poller's RawPosting into a stored row. This is the only place a
 * stored row is built, so id, normalizedKey, company, season, and salary are
 * all derived from the same values. Score and metros are not stored; see
 * present().
 *
 * Descriptions are stored as fetched (capped in buildPosting); they feed the
 * classifier and the salary parser and are not shown in the UI.
 */
export function enrichForStorage(p: RawPosting, now: string): StoredInternship {
  const company = canonicalizeCompany(stripEmojiPrefix(p.company));
  const link = stripUtm(p.link) || p.link;
  const location = p.locations[0] ?? '';

  // A source that states compensation is authoritative; otherwise parse
  // the title and full description.
  const salary = p.salary ?? parseSalary(`${p.title} ${p.description ?? ''}`);
  const description = p.description;

  return {
    id: createHash('md5').update(`${company}${p.title}${link}`).digest('hex'),
    title: p.title,
    company,
    location,
    locations: p.locations,
    link,
    source: p.source,
    postedAt: p.postedAt,
    seenAt: now,
    firstSeenAt: now,
    archived: false,
    failedCheckCount: 0,
    normalizedKey: normalizeKey(company, p.title),
    // Expired tokens on a multi-season posting are dropped; all-expired rows never reach here.
    season: openSeasonTokens(p.season ?? deriveSeasonWithDefault(p.title)),
    ...(description ? { description } : {}),
    ...(salary?.text ? {
      salaryText: salary.text,
      salaryMin: salary.min ?? undefined,
      salaryMax: salary.max ?? undefined,
      salaryUnit: salary.unit ?? undefined,
    } : {}),
  };
}
