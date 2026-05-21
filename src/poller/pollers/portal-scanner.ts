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
import { Internship } from '../../lib/types';
import { pollATS, ATSTarget } from './ats';
import { loadInternships, saveInternships } from '../../lib/store';

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
      // https://jobs.lever.co/{company}/{uuid} — last segment is the job id
      const parts = pathname.split('/').filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 1] : null;
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

      // Match to a target by ats type (source) and URL hostname
      let atsTarget = '';
      try {
        const linkHost = new URL(listing.link ?? '').hostname;
        const matched = targets.find((t) => {
          if (t.ats !== atsSource.toLowerCase()) return false;
          // Compare hostname part: e.g. "boards.greenhouse.io" for Greenhouse
          if (atsSource === 'Greenhouse') return linkHost.includes(t.slug);
          if (atsSource === 'Lever') return linkHost.includes('lever');
          if (atsSource === 'Ashby') return linkHost.includes('ashbyhq');
          if (atsSource === 'Workday') return linkHost.includes('workday');
          if (atsSource === 'iCIMS') return linkHost.includes('icims');
          if (atsSource === 'SmartRecruiters') return linkHost.includes('smartrecruiters');
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

interface PortalScanResult {
  listings: Array<Partial<Internship> & { atsJobId: string; atsTarget: string }>;
  archivedCounts: Record<string, number>; // targetSlug → count archived this run
}

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

  // Load ats-targets.json to match listings to target slugs
  let targets: ATSTarget[] = [];
  try {
    const configPath = path.join(process.cwd(), 'data', 'ats-targets.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    targets = config.targets ?? [];
  } catch {
    // No targets configured — skip enrichment
  }

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
  const internships = loadInternships();

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
    const prev = snapshots[targetSlug];
    const prevIds = new Set<string>(prev?.jobIds ?? []);

    const target = targets.find((t) => t.slug === targetSlug);
    const atsSource = target ? (ATS_SOURCE_LABEL[target.ats] ?? '') : '';

    const { archived } = archiveDisappeared(internships, currentIds, atsSource, targetSlug);
    if (archived.length > 0) {
      archivedByTarget[targetSlug] = archived.length;
      console.log(`[portal-scanner] ${targetSlug}: archived ${archived.length} disappeared listing(s)`);
    }

    // Update snapshot
    snapshots[targetSlug] = {
      timestamp: new Date().toISOString(),
      jobIds: [...currentIds],
    };
  }

  if (Object.keys(archivedByTarget).length > 0) {
    saveInternships(internships);
  }
  saveSnapshots(snapshots);

  return { listings: enriched, archivedByTarget };
}

// ---------------------------------------------------------------------------
// Re-export everything from ats.ts so callers only need to import from here
// ---------------------------------------------------------------------------
export { pollATS } from './ats';
export type { ATSTarget } from './ats';
export { isInternTitle } from './ats';
