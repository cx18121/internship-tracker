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

import * as fs from 'fs';
import * as path from 'path';
import { Internship, ATSTarget } from '../../lib/types';
import { pollATS } from './ats';
import { loadATSTargets } from '../../lib/utils/ats-discovery';
import { loadInternships, archiveInternshipsByIds } from '../../lib/store';

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
// Paths
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = path.join(process.cwd(), 'data', 'portal-snapshots.json');

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

function loadSnapshots(): Snapshots {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSnapshots(snapshots: Snapshots): void {
  const dir = path.dirname(SNAPSHOT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshots, null, 2));
}

// ---------------------------------------------------------------------------
// Job ID extraction from a listing's link
// ---------------------------------------------------------------------------

/**
 * Extracts the portal's canonical job ID from a listing's `link` URL.
 * Each ATS uses a different URL pattern — this handles them all.
 *
 * Returns the raw job ID string (e.g. "4829100123" for Greenhouse),
 * or null if the URL pattern is not recognised.
 */
export function extractPortalJobId(link: string, atsSource: string): string | null {
  try {
    const url = new URL(link);
    const pathname = url.pathname;

    if (atsSource === 'Greenhouse') {
      // https://boards.greenhouse.io/{board}/jobs/{id} or /jobs/{id}
      const m = pathname.match(/\/jobs\/(\d+)/);
      return m ? m[1] : null;
    }
    if (atsSource === 'Lever') {
      // https://jobs.lever.co/{company}/{uuid} — last segment is the job id.
      // pollLever() falls back to j.applyUrl when hostedUrl is missing, which
      // ends in /apply. Drop that suffix so all Lever rows from the same
      // tenant don't collide on the literal job id "apply".
      const parts = pathname.split('/').filter(Boolean);
      const trimmed = parts[parts.length - 1] === 'apply' ? parts.slice(0, -1) : parts;
      return trimmed.length >= 2 ? trimmed[trimmed.length - 1] : null;
    }
    if (atsSource === 'Ashby') {
      // https://jobs.ashbyhq.com/{board}/{id}
      const parts = pathname.split('/').filter(Boolean);
      // Last segment is the numeric/alphanumeric job id
      return parts.length >= 2 ? parts[parts.length - 1] : null;
    }
    if (atsSource === 'Workday') {
      // https://{tenant}.{wdInstance}.myworkdayjobs.com/job/{location}/{title}_{reqId}
      // The last segment encodes the req id; it's stable per posting.
      const parts = pathname.split('/').filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 1] : null;
    }
    if (atsSource === 'iCIMS') {
      // https://careers-{tenant}.icims.com/jobs/{id}/job
      const m = pathname.match(/\/jobs\/(\d+)/);
      return m ? m[1] : null;
    }
    if (atsSource === 'SmartRecruiters') {
      // https://jobs.smartrecruiters.com/{company}/{id}
      const parts = pathname.split('/').filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 1] : null;
    }

    return null;
  } catch {
    return null;
  }
}

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
  const snapshots = loadSnapshots();

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
  saveSnapshots(snapshots);

  return { listings: enriched, archivedByTarget };
}

// ---------------------------------------------------------------------------
// Re-export the runtime entrypoint from ats.ts. ATSTarget is now canonical in
// src/lib/types.ts — import from there directly.
// ---------------------------------------------------------------------------
export { pollATS } from './ats';
export { isInternTitle } from './ats';
