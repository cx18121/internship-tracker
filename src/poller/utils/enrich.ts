import { createHash } from 'node:crypto';
import type { Internship, RawPosting } from '../../lib/types';
import { stripUtm, stripEmojiPrefix } from '../../lib/utils/normalize';
import { scoreInternship } from '../../lib/scorer';
import { parseSalary } from '../../lib/salary';
import { normalizeKey } from '../../lib/normalize-key';
import { canonicalizeCompany } from '../../lib/canonicalize-company';
import { deriveSeasonWithDefault, openSeasonTokens } from '../../lib/seasons';
import { metrosFor } from '../../lib/metros';

/**
 * Promote a poller's RawPosting into the stored Internship. This is the only
 * place a stored row is built, so id, normalizedKey, company, season, and
 * salary are all derived from the same values.
 *
 * Descriptions are stored as fetched (capped in buildPosting); they feed the
 * classifier and the salary parser and are not shown in the UI.
 */
export function enrichForStorage(p: RawPosting, now: string): Internship {
  const company = canonicalizeCompany(stripEmojiPrefix(p.company));
  const link = stripUtm(p.link) || p.link;
  const location = p.locations[0] ?? '';
  const { score, scoreLabel, matchedKeywords, companyTier } = scoreInternship({ title: p.title, company, location });

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
    metros: metrosFor(p.locations),
    link,
    source: p.source,
    postedAt: p.postedAt,
    seenAt: now,
    score,
    scoreLabel,
    matchedKeywords,
    archived: false,
    failedCheckCount: 0,
    normalizedKey: normalizeKey(company, p.title),
    // Expired tokens on a multi-season posting are dropped; all-expired rows never reach here.
    season: openSeasonTokens(p.season ?? deriveSeasonWithDefault(p.title)),
    companyTier,
    ...(description ? { description } : {}),
    ...(salary?.text ? {
      salaryText: salary.text,
      salaryMin: salary.min ?? undefined,
      salaryMax: salary.max ?? undefined,
      salaryUnit: salary.unit ?? undefined,
    } : {}),
  };
}
