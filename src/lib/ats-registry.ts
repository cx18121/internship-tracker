// Per-ATS URL-parsing adapters. Two consumers share this table:
//
//   1. ats-discovery.ts — given an apply URL, recognise the ATS and pull the
//      target descriptor (slug + Workday-specific board/wdInstance) that
//      gets persisted to ats-targets.json.
//   2. portal-scanner.ts — given a stored row's link, pull the ATS's
//      canonical job id for portal-disappearance detection.
//
// Previously each consumer carried its own 6-branch if-else over the same
// 6 ATS kinds, plus the polling code in ats.ts dispatches off a third copy.
// Adding a 7th ATS used to require editing 3 files. After this, the URL
// half of that knowledge lives here; only the new pollX() and the dispatch
// in ats.ts still need updating.
//
// The polling side stays in ats.ts because each ATS API has a different
// request/response shape — Workday alone needs CSRF detection, facet
// discovery, and a Playwright fallback. The abstraction wouldn't earn its
// keep for that part.

import type { ATSTarget } from './types';

export type ATSKind = ATSTarget['ats'];

interface AtsAdapter {
  /** Hostname/pathname predicate. Both args lowercased by caller. */
  matchUrl(hostname: string, pathname: string): boolean;
  /**
   * Pull the discovery target (slug + per-kind extras) from a URL that
   * matched. Returns null when the URL matched the host check but didn't
   * yield a usable slug — e.g. a board landing page with no specific job.
   */
  extractTarget(hostname: string, pathname: string): Omit<ATSTarget, 'name'> | null;
  /**
   * Pull the canonical per-posting job id from the stored link. Used by
   * portal-disappearance detection (compare current vs. last-snapshot set).
   * Returns null when the URL doesn't fit the expected per-job shape.
   */
  extractJobId(hostname: string, pathname: string): string | null;
}

const LOCALE_RE = /^[a-z]{2}[-_][A-Z]{2}$/;

export const ATS_ADAPTERS: Record<ATSKind, AtsAdapter> = {
  greenhouse: {
    matchUrl: (h) => h === 'boards.greenhouse.io' || h === 'job-boards.greenhouse.io',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'greenhouse' } : null;
    },
    // boards.greenhouse.io/{board}/jobs/{id} or /jobs/{id}
    extractJobId: (_h, p) => p.match(/\/jobs\/(\d+)/)?.[1] ?? null,
  },

  lever: {
    matchUrl: (h) => h === 'jobs.lever.co' || h === 'lever.co',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'lever' } : null;
    },
    // jobs.lever.co/{company}/{uuid} — last segment is the job id. pollLever
    // falls back to j.applyUrl when hostedUrl is missing, which ends in /apply.
    // Drop that suffix so all Lever rows from the same tenant don't collide
    // on the literal job id "apply".
    extractJobId: (_h, p) => {
      const parts = p.split('/').filter(Boolean);
      const trimmed = parts[parts.length - 1] === 'apply' ? parts.slice(0, -1) : parts;
      return trimmed.length >= 2 ? trimmed[trimmed.length - 1] : null;
    },
  },

  ashby: {
    matchUrl: (h) => h === 'jobs.ashbyhq.com',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'ashby' } : null;
    },
    // jobs.ashbyhq.com/{board}/{id}
    extractJobId: (_h, p) => {
      const parts = p.split('/').filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 1] : null;
    },
  },

  // Workday has two URL variants:
  //   {company}.{wdInstance}.myworkdayjobs.com/{board}/job/{location}/{title}_{reqId}
  //   {wdInstance}.myworkdaysite.com/recruiting/{slug}/{board}/job/...
  // The job id is the trailing path segment in both. The discovery side
  // separates them because slug/board/wdInstance come from different parts.
  workday: {
    matchUrl: (h) => h.endsWith('.myworkdayjobs.com') || h.endsWith('.myworkdaysite.com'),
    extractTarget: (h, p) => {
      const isSiteVariant = h.endsWith('.myworkdaysite.com');
      const pathParts = p.split('/').filter(Boolean);
      if (isSiteVariant) {
        const wdInstance = h.split('.')[0];
        if (!wdInstance) return null;
        // Path: [locale?], 'recruiting', slug, board, 'job', ...
        const filtered = pathParts.filter((seg) => !LOCALE_RE.test(seg));
        const recIdx = filtered.indexOf('recruiting');
        if (recIdx < 0 || filtered.length < recIdx + 2) return null;
        return {
          slug: filtered[recIdx + 1],
          ats: 'workday',
          board: filtered[recIdx + 2],
          wdInstance,
          wdDomain: 'myworkdaysite.com',
        };
      }
      // jobs variant: {slug}.{wd?}.myworkdayjobs.com/{board}/job/...
      const parts = h.split('.');
      const slug = parts[0];
      if (!slug) return null;
      const wdInstance = parts.length >= 4 ? parts[1] : undefined;
      const board = pathParts.find((seg) => !LOCALE_RE.test(seg)) || undefined;
      return {
        slug,
        ats: 'workday',
        ...(board ? { board } : {}),
        ...(wdInstance ? { wdInstance } : {}),
      };
    },
    extractJobId: (_h, p) => {
      const parts = p.split('/').filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 1] : null;
    },
  },

  icims: {
    matchUrl: (h) => h.endsWith('.icims.com'),
    extractTarget: (h) => {
      const sub = h.replace('.icims.com', '');
      const slug = sub.startsWith('careers-') ? sub.slice('careers-'.length) : sub;
      return slug ? { slug, ats: 'icims' } : null;
    },
    // careers-{tenant}.icims.com/jobs/{id}/job
    extractJobId: (_h, p) => p.match(/\/jobs\/(\d+)/)?.[1] ?? null,
  },

  smartrecruiters: {
    matchUrl: (h) => h === 'jobs.smartrecruiters.com',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'smartrecruiters' } : null;
    },
    // jobs.smartrecruiters.com/{company}/{id}
    extractJobId: (_h, p) => {
      const parts = p.split('/').filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 1] : null;
    },
  },
};

/** Parse a URL and dispatch to the matching adapter, returning the ATS
 *  kind plus the host/path so consumers don't re-parse. */
function dispatch(link: string): { kind: ATSKind; adapter: AtsAdapter; hostname: string; pathname: string } | null {
  if (!link) return null;
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname;
  for (const kind of Object.keys(ATS_ADAPTERS) as ATSKind[]) {
    const adapter = ATS_ADAPTERS[kind];
    if (adapter.matchUrl(hostname, pathname)) {
      return { kind, adapter, hostname, pathname };
    }
  }
  return null;
}

/**
 * Public discovery shim. Returns the canonical target for a URL, including
 * the caller-supplied display name. Mirrors the previous discoverATSTarget
 * signature exactly so the call sites don't change.
 */
export function discoverATSTarget(link: string, companyName: string): ATSTarget | null {
  const d = dispatch(link);
  if (!d) return null;
  const target = d.adapter.extractTarget(d.hostname, d.pathname);
  return target ? { ...target, name: companyName } : null;
}

/**
 * Pull the per-posting job id from a stored link. Used by portal-scanner
 * to diff snapshot ⇄ current. The `atsSource` argument is now optional —
 * we re-derive the ATS kind from the URL, ignoring an out-of-sync stored
 * value. Returns null when the URL doesn't fit the per-job shape.
 */
export function extractJobIdFromLink(link: string): string | null {
  const d = dispatch(link);
  return d ? d.adapter.extractJobId(d.hostname, d.pathname) : null;
}
