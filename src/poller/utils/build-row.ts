// Row construction for poller output. Every poller produces partial
// Internship rows with the same four wiring fields — source, postedAt,
// seenAt, applied — and the same fallback rule: when the upstream ATS
// doesn't report a publication date, postedAt defaults to seenAt (poll
// time). Before this module that rule lived inline in 7+ places, with
// minor variations ("j.updated_at || now", "j.createdAt ? new Date(...)
// : now", etc.).
//
// Callers pass identifying fields, an optional upstream-reported
// publication timestamp, and the description (either pre-stripped plain
// text via `description` or raw HTML via `descriptionHtml` — never both).
// Source-specific extras (atsSource, multiLocation, salary fields) are
// spread in by the caller. The single truncation point downstream is
// smartTrimDescription in agent.ts; this layer only does null-collapse.

import type { Internship } from '../../lib/types';
import { stripHtml } from './html';

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
  /** Plain-text description. Pollers that already have stripped text
   *  (Lever via descriptionPlain, Ashby/Workday/SmartRecruiters via the
   *  description-fetcher helpers) pass it here. */
  description?: string | null;
  /** Raw HTML description. Pollers that hold unstripped markup
   *  (Greenhouse j.content, JobSpy when description_format=html) pass it
   *  here and buildInternshipRow strips. Mutually exclusive with
   *  `description` — if both are set, `descriptionHtml` wins. */
  descriptionHtml?: string | null;
}

export function buildInternshipRow(seed: RowSeed): Partial<Internship> {
  const rawDesc = seed.descriptionHtml
    ? stripHtml(seed.descriptionHtml)
    : (seed.description ?? '');
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
    description: rawDesc.trim() || undefined,
  };
}
