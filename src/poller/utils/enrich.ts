// Promotes a raw partial-internship (whatever the poller produced) into the
// fully-scored row that goes into deduplicateAndStore. Used by agent.ts.
//
// The pipeline ordering matters and is documented at each step. Scorer
// runs against the ORIGINAL (full-length, ~4000-char) description so it
// catches tech keywords from anywhere in the body; the smartTrim runs
// AFTER, so storage only keeps the UI-friendly subset (benefits/EEO/legal
// tail dropped, capped ~2000).

import md5 from 'md5';
import type { Internship } from '../../lib/types';
import { stripUtm, stripEmojiPrefix } from '../../lib/utils/normalize';
import { scoreInternship } from '../../lib/scorer';
import { parseSalary } from '../../lib/salary';
import { normalizeKey } from '../../lib/normalize-key';
import { canonicalizeCompany } from '../../lib/canonicalize-company';
import { buildInternshipRow } from './build-row';
import { smartTrimDescription } from './description-trim';

export function enrichForStorage(p: Partial<Internship>, now: string): Internship {
  const { score, scoreLabel, matchedKeywords } = scoreInternship(p);

  // Canonicalize the company name ONCE here — the storage chokepoint where
  // id, normalizedKey, and the stored company field are all set. Keeping them
  // derived from the same value is what lets cross-source dedup (store.ts)
  // collapse "NVIDIA" / "NVIDIA AI" and stops the by-company grouping from
  // splitting one company across two sections.
  const company = canonicalizeCompany(stripEmojiPrefix(p.company || ''));

  // Parse salary from title + description — the two fields most likely to
  // mention pay. Done against the pre-trim description so a salary line
  // buried in benefits boilerplate isn't lost.
  const salary = parseSalary(`${p.title || ''} ${p.description || ''}`);

  return {
    ...buildInternshipRow({
      title: p.title || '',
      company,
      location: p.location || '',
      link: p.link || '',
      source: p.source || 'Unknown',
      upstreamPostedAt: p.postedAt,
      seenAt: now,
    }),
    id: md5(`${company}${p.title || ''}${stripUtm(p.link || '')}`),
    description: smartTrimDescription(p.description) || undefined,
    // ATS provenance is set by github/portal-scanner pollers and required by
    // portal-scanner's archiveDisappeared() (closing detection). Forward it.
    atsSource: p.atsSource,
    atsJobId: p.atsJobId,
    atsTarget: p.atsTarget,
    multiLocation: p.multiLocation,
    score,
    scoreLabel,
    matchedKeywords,
    isNew: true,
    normalizedKey: normalizeKey(company, p.title || ''),
    ...(salary.text ? {
      salaryText: salary.text,
      salaryMin: salary.min ?? undefined,
      salaryMax: salary.max ?? undefined,
      salaryUnit: salary.unit ?? undefined,
    } : {}),
  } as Internship;
}
