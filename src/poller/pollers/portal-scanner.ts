/**
 * Portal scanner — the canonical entry point for ATS polling.
 *
 * Wraps pollATS() with portal-disappearance detection:
 * after each scan, compares current job IDs against the last snapshot.
 * Any listing whose portal ID is no longer present on the portal is
 * marked archived in the store.
 *
 * Snapshot format (data/portal-snapshots.json):
 * {
 *   [targetSlug]: { timestamp: string, jobIds: string[] }
 * }
 */

import { Internship, ATSTarget } from '../../lib/types';
import { pollATS } from './ats';
import { loadATSTargets } from '../../lib/utils/ats-discovery';
import { loadInternships, archiveInternshipsByIds } from '../../lib/store';
import { jsonStore } from '../../lib/sidecar';
import { extractJobIdFromLink } from '../../lib/ats-registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of seen job IDs for one ATS target at a point in time. */
interface PortalSnapshot {
  timestamp: string;
  jobIds: string[];
}

type Snapshots = Record<string, PortalSnapshot>;

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

const snapshotStore = jsonStore<Snapshots>('portal-snapshots.json', {});

// ---------------------------------------------------------------------------
// Job ID extraction from a listing's link
// ---------------------------------------------------------------------------

// Job-id extraction by ATS URL shape lives in src/lib/ats-registry.ts —
// the same table that drives discovery. Re-export under the historical
// name so callers that import this don't need to change.
export const extractPortalJobId = (link: string, _atsSource?: string): string | null =>
  extractJobIdFromLink(link);

// ---------------------------------------------------------------------------
// Archive disappeared listings
// ---------------------------------------------------------------------------

/**
 * Marks as archived every non-archived internship in the store that:
 *   1. belongs to `atsSource`, AND
 *   2. has an `atsTarget` matching `targetSlug`, AND
 *   3. is NOT in `currentJobIds`.
 *
 * The `atsTarget` field links a listing back to its ATS target config slug.
 */
export function archiveDisappeared(
  internships: Internship[],
  currentJobIds: Set<string>,
  atsSource: string,
  targetSlug: string,
): { archived: string[] } {
  const archived: string[] = [];

  for (const internship of internships) {
    if (
      !internship.archived &&
      internship.atsSource === atsSource &&
      internship.atsTarget === targetSlug &&
      internship.atsJobId != null &&
      !currentJobIds.has(internship.atsJobId)
    ) {
      internship.archived = true;
      archived.push(internship.id);
    }
  }

  return { archived };
}

// ---------------------------------------------------------------------------
// Enrich listings with portal ID metadata
// ---------------------------------------------------------------------------

/**
 * Given an array of raw ATS listings, enriches each with the extracted
 * portal job ID and target slug (the slug from ats-targets.json that
 * matched this listing).
 *
 * We match on `source` (e.g. "Greenhouse") and, where possible, on
 * URL pattern to recover the original ATS target slug.
 */
function enrichWithPortalMeta(
  listings: Partial<Internship>[],
  targets: ATSTarget[],
): Array<Partial<Internship> & { atsJobId: string; atsTarget: string }> {
  return listings
    .map((listing) => {
      const atsSource = listing.source ?? '';
      // Try to recover the target slug from the URL
      const atsJobId = extractPortalJobId(listing.link ?? '', atsSource);
      if (!atsJobId) return null;

      // Match to a target by ats type (source) and the slug encoded in the
      // listing URL. Substring-on-hostname (the old approach) tagged every
      // Lever/Ashby/Workday listing with whichever target happened to come
      // first in config — break portal-disappearance archival across all
      // tenants on the same ATS.
      let atsTarget = '';
      try {
        const linkUrl = new URL(listing.link ?? '');
        const linkHost = linkUrl.hostname;
        const pathSegments = linkUrl.pathname.split('/').filter(Boolean);
        const firstPath = pathSegments[0] ?? '';
        const matched = targets.find((t) => {
          if (t.ats !== atsSource.toLowerCase()) return false;
          // Greenhouse: boards.greenhouse.io/{slug}/jobs/{id} (or job-boards.greenhouse.io/{slug}/...)
          if (atsSource === 'Greenhouse') return firstPath === t.slug;
          // Lever: jobs.lever.co/{slug}/{id}
          if (atsSource === 'Lever') return firstPath === t.slug;
          // Ashby: jobs.ashbyhq.com/{slug}/{id}
          if (atsSource === 'Ashby') return firstPath === t.slug;
          // SmartRecruiters: jobs.smartrecruiters.com/{slug}/{id}
          if (atsSource === 'SmartRecruiters') return firstPath === t.slug;
          // iCIMS: careers-{slug}.icims.com
          if (atsSource === 'iCIMS') return linkHost.startsWith(`careers-${t.slug}.`);
          // Workday: {slug}.{wdInstance}.myworkdayjobs.com OR site-variant
          // {wdInstance}.myworkdaysite.com/recruiting/{slug}/...
          if (atsSource === 'Workday') {
            if (linkHost.startsWith(`${t.slug}.`)) return true;
            return pathSegments[0] === 'recruiting' && pathSegments[1] === t.slug;
          }
          // Rippling: ats.rippling.com/[locale/]{slug}/jobs/{uuid} — slug is the
          // first non-locale path segment (mirrors the registry's extractTarget).
          if (atsSource === 'Rippling') {
            const slugSeg = pathSegments.find((s) => !/^[a-z]{2}[-_][A-Z]{2}$/.test(s)) ?? '';
            return slugSeg === t.slug;
          }
          // Workable: apply.workable.com/{slug}/j/{shortcode}
          if (atsSource === 'Workable') return firstPath === t.slug;
          return false;
        });
        atsTarget = matched?.slug ?? '';
      } catch {
        atsTarget = '';
      }

      return {
        ...listing,
        atsJobId,
        atsTarget,
      } as Partial<Internship> & { atsJobId: string; atsTarget: string };
    })
    .filter((l): l is ReturnType<typeof enrichWithPortalMeta>[number] => l !== null);
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export interface PortalScanOutput {
  listings: Array<Partial<Internship> & { atsJobId: string; atsTarget: string }>;
  archivedByTarget: Record<string, number>;
}

/**
 * Runs the full portal scan:
 *   1. Polls all ATS targets (same as pollATS())
 *   2. Extracts portal job IDs from each returned listing
 *   3. Compares against last snapshot per target
 *   4. Archives disappeared listings
 *   5. Saves updated snapshots
 *
 * Returns enriched listings and a map of target → number of newly archived.
 */
export async function scanPortals(): Promise<PortalScanOutput> {
  const rawListings = await pollATS();
  const snapshots = snapshotStore.load();

  // Load ats-targets.json to match listings to target slugs. Empty array
  // (missing/malformed file) means enrichment is a no-op.
  const targets: ATSTarget[] = loadATSTargets();

  const enriched = enrichWithPortalMeta(rawListings, targets);

  // Build current job-id sets per target
  const currentByTarget = new Map<string, Set<string>>();
  for (const listing of enriched) {
    if (!listing.atsTarget) continue;
    if (!currentByTarget.has(listing.atsTarget)) {
      currentByTarget.set(listing.atsTarget, new Set());
    }
    currentByTarget.get(listing.atsTarget)!.add(listing.atsJobId);
  }

  // Update snapshots and archive disappeared listings
  const archivedByTarget: Record<string, number> = {};
  const internships = await loadInternships();
  const allArchivedIds: string[] = [];

  // Must match the source labels ats.ts writes when storing internships,
  // otherwise archival never matches. Naive .toUpperCase()-on-first-letter
  // breaks 'iCIMS' and 'SmartRecruiters' (and would break any future ATS
  // whose canonical label isn't simply Capitalized).
  const ATS_SOURCE_LABEL: Record<string, string> = {
    greenhouse: 'Greenhouse',
    lever: 'Lever',
    ashby: 'Ashby',
    workday: 'Workday',
    icims: 'iCIMS',
    smartrecruiters: 'SmartRecruiters',
    rippling: 'Rippling',
    workable: 'Workable',
  };

  for (const [targetSlug, currentIds] of currentByTarget) {
    const target = targets.find((t) => t.slug === targetSlug);
    const atsSource = target ? (ATS_SOURCE_LABEL[target.ats] ?? '') : '';

    const { archived } = archiveDisappeared(internships, currentIds, atsSource, targetSlug);
    if (archived.length > 0) {
      archivedByTarget[targetSlug] = archived.length;
      allArchivedIds.push(...archived);
      console.log(`[portal-scanner] ${targetSlug}: archived ${archived.length} disappeared listing(s)`);
    }

    // Update snapshot
    snapshots[targetSlug] = {
      timestamp: new Date().toISOString(),
      jobIds: [...currentIds],
    };
  }

  // Narrow per-id UPDATE inside withLock instead of saveInternships(internships)
  // (full-column upsert of every row). scanPortals holds the in-memory
  // `internships` array across slow ATS HTTP fetches, so a full-row write
  // at the end would clobber any PATCH from the UI/Discord/daily-ATS-script
  // that landed in the meantime. archiveDisappeared mutates only `archived`,
  // and we now persist only that column for exactly the affected ids.
  if (allArchivedIds.length > 0) {
    await archiveInternshipsByIds(allArchivedIds);
  }
  snapshotStore.save(snapshots);

  return { listings: enriched, archivedByTarget };
}

// ---------------------------------------------------------------------------
// Re-export the runtime entrypoint from ats.ts. ATSTarget is now canonical in
// src/lib/types.ts — import from there directly.
// ---------------------------------------------------------------------------
export { pollATS } from './ats';
export { isInternTitle } from './ats';
