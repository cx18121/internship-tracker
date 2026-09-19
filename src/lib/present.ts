import type { StoredInternship, Internship } from './types';
import { scoreInternship } from './scorer';
import { metrosFor } from './metros';
import { openSeasonTokens } from './seasons';

/**
 * Derive everything the API and UI need from a stored row. Runs on every
 * read, so a change to the scoring config, the metro table, or a company's
 * tier is visible immediately with no stored copy to go stale.
 */
export function present(row: StoredInternship, now = new Date()): Internship {
  const s = scoreInternship({ title: row.title, company: row.company, location: row.location, roleType: row.roleType, companyTier: row.companyTier });
  return {
    ...row,
    score: s.score,
    scoreLabel: s.scoreLabel,
    companyTier: s.companyTier,
    matchedKeywords: s.matchedKeywords,
    metros: metrosFor(row.locations),
    season: openSeasonTokens(row.season, now),
  };
}
