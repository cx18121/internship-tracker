import type { Internship } from '../lib/types';
import { getInternships, archiveInternshipsByIds, updateDescription, updateScores, getUnclassified, getCompanyProfiles } from '../lib/store';
import { isExpiredSeasonTokens } from '../lib/seasons';
import { scoreInternship } from '../lib/scorer';
import { classifyLocation } from './iso-locations';
import { classifyRows, archiveReason, companyKey } from './classify';
import { fetchDescriptionByUrl } from './utils/description-fetchers';
import { pool } from '../lib/concurrency';
import { ATS_SOURCES } from './pollers/ats';

// A board we poll every cycle stops listing a job the moment it closes, so a
// row from one of those sources that no poll has touched in a week is gone.
// Aggregator feeds (SimplifyJobs, LinkedIn, Indeed, Handshake) only show
// recent items, so absence there is a weaker signal; give it a month.
const POLLED_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const FEED_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const POLLED_SOURCES = new Set<string>([...ATS_SOURCES, 'YC WaaS']);

const DEFAULT_CAPS = { descriptions: 300, classify: 400 };

export interface ReevaluateResult {
  archived: Record<string, number>;
  descriptionsFetched: number;
  classified: number;
  rescored: number;
}

/** Why a stored row should leave the active corpus, or null to keep it. */
export function staleReason(i: Internship, now = Date.now()): string | null {
  const age = now - new Date(i.seenAt).getTime();
  if (age > (POLLED_SOURCES.has(i.source) ? POLLED_STALE_MS : FEED_STALE_MS)) return 'not seen';
  if (isExpiredSeasonTokens(i.season)) return 'expired season';
  if (classifyLocation(i.location) === 'non_us') return 'non-US location';
  if (i.classifiedAt && i.roleType && i.degrees && i.usEligible && i.isInternship !== undefined) {
    const r = archiveReason({ roleType: i.roleType, degrees: i.degrees, usEligible: i.usEligible, isInternship: i.isInternship });
    if (r) return r;
  }
  return null;
}

/**
 * Daily pass over the active corpus: archive rows that are gone or out of
 * scope, fill missing descriptions from the final ATS URL, classify rows the
 * poller has not judged yet, and rescore everything against the current
 * config and company tiers.
 */
export async function reevaluate(caps: { descriptions: number; classify: number } = DEFAULT_CAPS): Promise<ReevaluateResult> {
  const result: ReevaluateResult = { archived: {}, descriptionsFetched: 0, classified: 0, rescored: 0 };
  const active = await getInternships({ includeHidden: true });

  const toArchive: string[] = [];
  for (const i of active) {
    const reason = staleReason(i);
    if (!reason) continue;
    toArchive.push(i.id);
    result.archived[reason] = (result.archived[reason] ?? 0) + 1;
  }
  await archiveInternshipsByIds(toArchive);
  const remaining = active.filter(i => !toArchive.includes(i.id));
  console.log(`[reevaluate] ${active.length} active, archived ${toArchive.length} ${JSON.stringify(result.archived)}`);

  // Descriptions: the final link usually resolves to an ATS we can read.
  const missing = remaining.filter(i => !i.description && !i.classifiedAt).slice(0, caps.descriptions);
  await pool(missing, 6, async (i) => {
    const desc = await fetchDescriptionByUrl(i.link);
    if (!desc) return;
    await updateDescription(i.id, desc);
    i.description = desc;
    result.descriptionsFetched++;
  });
  console.log(`[reevaluate] fetched ${result.descriptionsFetched}/${missing.length} missing descriptions`);

  // Classification backlog (new rows are classified in the poll cycle; this
  // catches failures and the pre-classifier corpus).
  const unclassified = (await getUnclassified(caps.classify)).map(u => remaining.find(r => r.id === u.id) ?? u);
  const outcome = await classifyRows(unclassified);
  result.classified = unclassified.length - outcome.failed;

  // Rescore already-classified rows so config or company-tier changes reach them.
  const classifiedRows = remaining.filter(i => i.classifiedAt && !unclassified.some(u => u.id === i.id));
  const tiers = await getCompanyProfiles([...new Set(classifiedRows.map(i => companyKey(i.company)))]);
  const updates = [];
  for (const i of classifiedRows) {
    const companyTier = tiers.get(companyKey(i.company))?.tier ?? i.companyTier;
    const s = scoreInternship({ title: i.title, company: i.company, location: i.location, roleType: i.roleType, companyTier });
    if (s.score !== i.score || s.companyTier !== i.companyTier) {
      updates.push({ id: i.id, score: s.score, scoreLabel: s.scoreLabel, matchedKeywords: s.matchedKeywords, companyTier: s.companyTier });
    }
  }
  await updateScores(updates);
  result.rescored = updates.length;
  console.log(`[reevaluate] classified ${result.classified}, rescored ${result.rescored}`);
  return result;
}
