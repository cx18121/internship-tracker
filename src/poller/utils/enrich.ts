import { createHash } from 'node:crypto';
import type { StoredInternship, RawPosting } from '../../lib/types';
import { stripUtm, stripEmojiPrefix } from '../../lib/utils/normalize';
import { parseSalary } from '../../lib/salary';
import { normalizeKey } from '../../lib/normalize-key';
import { canonicalizeCompany } from '../../lib/canonicalize-company';
import { deriveSeasonWithDefault, openSeasonTokens } from '../../lib/seasons';
import { jobKey, postingKey, ATS_SOURCES } from '../ats';
import { openingFacts, explicitInternshipTerms } from '../../lib/opportunity';

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
    ...(link ? { jobKey: jobKey(link) } : {}),
    identities: [{ ...p.identity,
      postingKey: p.identity?.postingKey ?? postingKey(link),
      sourceUrl: p.identity?.sourceUrl ?? link,
      title: p.identity?.title ?? p.title,
      terms: [...new Set(p.identity?.terms.length ? p.identity.terms : p.explicitTerms ?? p.season ?? explicitInternshipTerms(p.title, p.description))],
      facts: p.identity?.facts ?? p.openingFacts ?? openingFacts(p.description ?? ''),
      // Capture raw spelling BEFORE canonicalizeCompany, which has display/scoring aliases.
      employer: p.identity?.employer ?? ((p.companyObserved ?? !ATS_SOURCES.includes(p.source)) && p.company.trim()
        ? { name: stripEmojiPrefix(p.company), reference: link, kind: 'source' as const } : undefined),
    }],
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
