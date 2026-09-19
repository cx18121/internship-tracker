import type { Internship, StoredInternship } from '../lib/types';
import { getInternships, archiveInternshipsByIds, updateDescription, updateLocations, getUnclassified } from '../lib/store';
import { isExpiredSeasonTokens } from '../lib/seasons';
import { classifyLocation } from './iso-locations';
import { classifyRows, archiveReason } from './classify';
import { fetchDescriptionByUrl, fetchWorkdayDetailByUrl } from './utils/description-fetchers';
import { pool } from '../lib/concurrency';
import { POLLED_SOURCES } from './sources';
import { checkFeedLinks } from './link-health';

// A board we poll every cycle stops listing a job the moment it closes, so a
// row from one of those sources that no poll has touched in a week is gone.
// Aggregator feeds (SimplifyJobs, LinkedIn, Indeed, Handshake) only show
// recent items, so absence there is a weaker signal; give it a month.
const POLLED_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const FEED_STALE_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_CAPS = { descriptions: 300, classify: 400 };

export interface ReevaluateResult {
  archived: Record<string, number>;
  linksArchived: number;
  descriptionsFetched: number;
  classified: number;
}

/** Why a stored row should leave the active corpus, or null to keep it. */
export function staleReason(i: StoredInternship, now = Date.now()): string | null {
  const age = now - new Date(i.seenAt).getTime();
  if (age > (POLLED_SOURCES.has(i.source) ? POLLED_STALE_MS : FEED_STALE_MS)) return 'not seen';
  if (isExpiredSeasonTokens(i.season)) return 'expired season';
  if (i.locations.length > 0 && i.locations.every(l => classifyLocation(l) === 'non_us')) return 'non-US location';
  if (i.classifiedAt && i.roleType && i.degrees && i.usEligible && i.isInternship !== undefined) {
    const r = archiveReason({ roleType: i.roleType, degrees: i.degrees, usEligible: i.usEligible, isInternship: i.isInternship });
    if (r) return r;
  }
  return null;
}

/**
 * Daily pass over the active corpus: check feed links, archive rows that are
 * gone or out of scope, fill missing descriptions from the final ATS URL, classify rows the
 * poller has not judged yet, and rescore everything against the current
 * config and company tiers.
 */
export async function reevaluate(caps: { descriptions: number; classify: number } = DEFAULT_CAPS): Promise<ReevaluateResult> {
  const result: ReevaluateResult = { archived: {}, linksArchived: 0, descriptionsFetched: 0, classified: 0 };
  result.linksArchived = (await checkFeedLinks()).archived;
  const active = await getInternships();

  const toArchive = new Map<string, string[]>();
  const stale = new Set<string>();
  for (const i of active) {
    const reason = staleReason(i);
    if (!reason) continue;
    stale.add(i.id);
    toArchive.set(reason, [...(toArchive.get(reason) ?? []), i.id]);
    result.archived[reason] = (result.archived[reason] ?? 0) + 1;
  }
  // One row per (company, normalized title): keep the best-scored copy,
  // fold the others' locations into it, archive them.
  const byKey = new Map<string, Internship[]>();
  for (const i of active) if (i.normalizedKey && !stale.has(i.id)) byKey.set(i.normalizedKey, [...(byKey.get(i.normalizedKey) ?? []), i]);
  const dupes: string[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.description?.length ?? 0) - (a.description?.length ?? 0));
    const keep = group[0];
    const merged = [...new Set(group.flatMap(g => g.locations))].filter(l => !/^\d+ locations?$/i.test(l));
    if (merged.length > keep.locations.length) {
      keep.locations = merged;
      await updateLocations(keep.id, merged);
    }
    dupes.push(...group.slice(1).map(g => g.id));
  }
  if (dupes.length > 0) { toArchive.set('duplicate', dupes); result.archived.duplicate = dupes.length; }

  for (const [reason, ids] of toArchive) await archiveInternshipsByIds(ids, reason);
  const archivedIds = new Set([...toArchive.values()].flat());
  const remaining = active.filter(i => !archivedIds.has(i.id));
  console.log(`[reevaluate] ${active.length} active, archived ${archivedIds.size} ${JSON.stringify(result.archived)}`);

  // Workday rows kept alive by a feed never see the Workday poller, so their
  // location is still the list endpoint's "N Locations" count. The detail
  // call that supplies the description also supplies the real locations.
  const isCount = (l: string) => /^\d+ locations?$/i.test(l);
  const needsWorkdayDetail = (i: Internship) => /myworkday(jobs|site)\.com/.test(i.link) && (!i.description || i.locations.some(isCount));
  // Unclassified rows first so the classifier sees the text.
  const missing = remaining
    .filter(i => !i.description || needsWorkdayDetail(i))
    .sort((a, b) => Number(!!a.classifiedAt) - Number(!!b.classifiedAt))
    .slice(0, caps.descriptions);
  await pool(missing, 6, async (i) => {
    if (needsWorkdayDetail(i)) {
      const d = await fetchWorkdayDetailByUrl(i.link);
      if (d.locations.length > 0 && i.locations.some(isCount)) {
        i.locations = d.locations;
        await updateLocations(i.id, i.locations);
      }
      if (d.description && !i.description) { await updateDescription(i.id, d.description); i.description = d.description; result.descriptionsFetched++; }
      return;
    }
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

  console.log(`[reevaluate] classified ${result.classified}`);
  return result;
}
