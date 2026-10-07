import type { RawPosting, PostingIdentity } from '../../lib/types';
import { stripHtml, identityText } from './html';
import { openingFacts, explicitInternshipTerms } from '../../lib/opportunity';

// Enough for the classifier and salary parser; descriptions are not shown in the UI.
const MAX_RAW_DESCRIPTION = 6_000;

export interface PostingSeed {
  title: string;
  company: string;
  /** Set only for a source-provided employer name, not a configured ATS label. */
  companyObserved?: boolean;
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
  identity?: PostingIdentity;
}

function isStorableDate(v: string | null | undefined): v is string {
  return !!v && !Number.isNaN(Date.parse(v));
}

export function buildPosting(seed: PostingSeed): RawPosting {
  const full = seed.descriptionHtml ? identityText(seed.descriptionHtml) : seed.description ?? '';
  const description = (seed.descriptionHtml ? stripHtml(seed.descriptionHtml) : full).trim().slice(0, MAX_RAW_DESCRIPTION);
  const terms = seed.season ?? explicitInternshipTerms(seed.title, full);
  const locations = [...new Set([seed.location, ...(seed.locations ?? [])].map(l => (l ?? '').trim()).filter(Boolean))];
  return {
    title: seed.title,
    company: seed.company,
    locations,
    link: seed.link,
    source: seed.source,
    companyObserved: seed.companyObserved ?? false,
    openingFacts: openingFacts(full),
    explicitTerms: terms,
    ...(isStorableDate(seed.upstreamPostedAt) ? { postedAt: seed.upstreamPostedAt } : {}),
    ...(description ? { description } : {}),
    ...(seed.season && seed.season.length > 0 ? { season: seed.season } : {}),
    ...(seed.salary?.text ? { salary: seed.salary } : {}),
    ...(seed.identity ? { identity: seed.identity } : {}),
  };
}
