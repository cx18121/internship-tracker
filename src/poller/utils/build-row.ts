// Row construction for poller output. Every poller produces partial
// Internship rows with the same four wiring fields — source, postedAt,
// seenAt, applied — and the same fallback rule: when the upstream ATS
// doesn't report a publication date, postedAt defaults to seenAt (poll
// time). Before this module that rule lived inline in 7+ places, with
// minor variations ("j.updated_at || now", "j.createdAt ? new Date(...)
// : now", etc.).
//
// Callers pass the always-required identifying fields plus an optional
// upstream-reported publication timestamp. Source-specific extras
// (description, atsSource, multiLocation, salary fields) are spread
// in by the caller — they aren't part of the wiring, just the row.

import type { Internship } from '../../lib/types';

export interface RowSeed {
  title: string;
  company: string;
  link: string;
  location?: string | null;
  source: string;
  /** ISO timestamp the upstream ATS reports for publication. Falls back
   *  to `seenAt` when null/empty — keeps the "freshness" floor honest
   *  for sources that don't expose a real date. */
  upstreamPostedAt?: string | null;
  /** ISO timestamp the poller is using as "now". Threaded from the
   *  caller so an entire poll batch shares one timestamp. */
  seenAt: string;
}

export function buildInternshipRow(seed: RowSeed): Partial<Internship> {
  // Internship.location is typed as `string` (not nullable). Existing
  // pollers fall back to '' when no location is known; mirror that here
  // so the typed surface stays narrow.
  return {
    title: seed.title,
    company: seed.company,
    location: seed.location ?? '',
    link: seed.link,
    source: seed.source,
    postedAt: seed.upstreamPostedAt || seed.seenAt,
    seenAt: seed.seenAt,
    applied: false,
  };
}
