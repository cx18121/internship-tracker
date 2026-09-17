import type { RawPosting } from '../../lib/types';
import { stripHtml } from './html';

// Memory floor before scoring; smartTrimDescription applies the storage cap.
const MAX_RAW_DESCRIPTION = 20_000;

export interface PostingSeed {
  title: string;
  company: string;
  link: string;
  location?: string | null;
  source: string;
  /** Publication timestamp the source reports. Falls back to `now` when
   *  missing or unparseable (JobSpy emits "5 days ago", which Postgres
   *  rejects). */
  upstreamPostedAt?: string | null;
  /** Poll time, shared by the whole batch. */
  now: string;
  /** Plain-text description. */
  description?: string | null;
  /** Raw HTML description; stripped here. Wins over `description`. */
  descriptionHtml?: string | null;
  season?: string[];
  salary?: RawPosting['salary'];
  multiLocation?: string[];
}

function isStorableDate(v: string | null | undefined): v is string {
  return !!v && !Number.isNaN(Date.parse(v));
}

export function buildPosting(seed: PostingSeed): RawPosting {
  const description = (seed.descriptionHtml ? stripHtml(seed.descriptionHtml) : seed.description ?? '').trim().slice(0, MAX_RAW_DESCRIPTION);
  return {
    title: seed.title,
    company: seed.company,
    location: seed.location ?? '',
    link: seed.link,
    source: seed.source,
    postedAt: isStorableDate(seed.upstreamPostedAt) ? seed.upstreamPostedAt : seed.now,
    ...(description ? { description } : {}),
    ...(seed.season && seed.season.length > 0 ? { season: seed.season } : {}),
    ...(seed.salary?.text ? { salary: seed.salary } : {}),
    ...(seed.multiLocation && seed.multiLocation.length > 1 ? { multiLocation: seed.multiLocation } : {}),
  };
}
