import { createHash } from 'node:crypto';
import type { Internship, RawPosting } from '../../lib/types';
import { stripUtm, stripEmojiPrefix } from '../../lib/utils/normalize';
import { scoreInternship } from '../../lib/scorer';
import { parseSalary } from '../../lib/salary';
import { normalizeKey } from '../../lib/normalize-key';
import { canonicalizeCompany } from '../../lib/canonicalize-company';
import { deriveSeasonWithDefault } from '../../lib/seasons';
import { smartTrimDescription } from './description-trim';

/**
 * Promote a poller's RawPosting into the stored Internship. This is the only
 * place a stored row is built, so id, normalizedKey, company, season, and
 * salary are all derived from the same values.
 *
 * The scorer runs against the full description; smartTrim runs after so
 * storage keeps only the UI-friendly subset.
 */
export function enrichForStorage(p: RawPosting, now: string): Internship {
  const company = canonicalizeCompany(stripEmojiPrefix(p.company));
  const link = stripUtm(p.link) || p.link;
  const { score, scoreLabel, matchedKeywords, companyTier } = scoreInternship({ title: p.title, company, location: p.location });

  // A source that states compensation is authoritative; otherwise parse
  // the title and full description.
  const salary = p.salary ?? parseSalary(`${p.title} ${p.description ?? ''}`);
  const description = smartTrimDescription(p.description);

  return {
    id: createHash('md5').update(`${company}${p.title}${link}`).digest('hex'),
    title: p.title,
    company,
    location: p.location,
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
    season: p.season ?? deriveSeasonWithDefault(p.title),
    companyTier,
    ...(description ? { description } : {}),
    ...(p.multiLocation ? { multiLocation: p.multiLocation } : {}),
    ...(salary?.text ? {
      salaryText: salary.text,
      salaryMin: salary.min ?? undefined,
      salaryMax: salary.max ?? undefined,
      salaryUnit: salary.unit ?? undefined,
    } : {}),
  };
}
