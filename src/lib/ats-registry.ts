// Per-ATS URL-parsing adapters: given an apply URL, recognise the ATS and
// pull the target descriptor (slug + Workday-specific board/wdInstance) that
// ats-discovery.ts persists to ats-targets.json.
//
// The polling side stays in ats.ts because each ATS API has a different
// request/response shape.

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
}

const LOCALE_RE = /^[a-z]{2}[-_][A-Z]{2}$/;

const ATS_ADAPTERS: Record<ATSKind, AtsAdapter> = {
  greenhouse: {
    matchUrl: (h) => h === 'boards.greenhouse.io' || h === 'job-boards.greenhouse.io',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'greenhouse' } : null;
    },
  },

  lever: {
    matchUrl: (h) => h === 'jobs.lever.co' || h === 'lever.co',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'lever' } : null;
    },
  },

  ashby: {
    matchUrl: (h) => h === 'jobs.ashbyhq.com',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'ashby' } : null;
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
  },

  icims: {
    matchUrl: (h) => h.endsWith('.icims.com'),
    extractTarget: (h) => {
      const sub = h.replace('.icims.com', '');
      const slug = sub.startsWith('careers-') ? sub.slice('careers-'.length) : sub;
      return slug ? { slug, ats: 'icims' } : null;
    },
  },

  smartrecruiters: {
    matchUrl: (h) => h === 'jobs.smartrecruiters.com',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'smartrecruiters' } : null;
    },
  },

  // Rippling's own multi-tenant ATS. Board URL: ats.rippling.com/{slug}/jobs/{uuid},
  // optionally with a /{locale}/ prefix (e.g. /en-US/). The first non-locale path
  // segment is the board slug and doubles as the API board id:
  //   https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
  rippling: {
    matchUrl: (h) => h === 'ats.rippling.com',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean).find((seg) => !LOCALE_RE.test(seg));
      return slug ? { slug, ats: 'rippling' } : null;
    },
  },

  // Workable. Apply URL: apply.workable.com/{slug}/j/{shortcode}[/apply]. The
  // first path segment is the account slug, used directly against the public
  // list API: POST https://apply.workable.com/api/v3/accounts/{slug}/jobs
  workable: {
    matchUrl: (h) => h === 'apply.workable.com',
    extractTarget: (_h, p) => {
      const slug = p.split('/').filter(Boolean)[0];
      return slug ? { slug, ats: 'workable' } : null;
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
