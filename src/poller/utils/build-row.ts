import type { RawPosting } from '../../lib/types';
import { stripHtml } from './html';

// Enough for the classifier and salary parser; descriptions are not shown in the UI.
const MAX_RAW_DESCRIPTION = 6_000;

export interface PostingSeed {
  title: string;
  company: string;
  link: string;
  /** One or more raw location strings; empties are dropped. */
  location?: string | null;
  locations?: Array<string | null | undefined>;
  source: string;
  /** Publication timestamp the source reports. Dropped when missing or
   *  unparseable (JobSpy emits "5 days ago"). */
  upstreamPostedAt?: string | null;
  /** Poll time, shared by the whole batch. */
  now: string;
  /** Plain-text description. */
  description?: string | null;
  /** Raw HTML description; stripped here. Wins over `description`. */
  descriptionHtml?: string | null;
  season?: string[];
  salary?: RawPosting['salary'];
}

function isStorableDate(v: string | null | undefined): v is string {
  return !!v && !Number.isNaN(Date.parse(v));
}

export function buildPosting(seed: PostingSeed): RawPosting {
  const description = (seed.descriptionHtml ? stripHtml(seed.descriptionHtml) : seed.description ?? '').trim().slice(0, MAX_RAW_DESCRIPTION);
  const locations = [...new Set([seed.location, ...(seed.locations ?? [])].map(l => (l ?? '').trim()).filter(Boolean))];
  return {
    title: seed.title,
    company: seed.company,
    locations,
    link: seed.link,
    source: seed.source,
    ...(isStorableDate(seed.upstreamPostedAt) ? { postedAt: seed.upstreamPostedAt } : {}),
    ...(description ? { description } : {}),
    ...(seed.season && seed.season.length > 0 ? { season: seed.season } : {}),
    ...(seed.salary?.text ? { salary: seed.salary } : {}),
  };
}
