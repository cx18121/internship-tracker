import type { Salary } from './salary';
import type { RoleType, Degree } from './classify/posting';
import type { CompanyTier } from './classify/company';
import type { Metro } from './metros';

export type ScoreLabel = 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * One listing as a poller reports it. Everything derived (id, score,
 * default season, normalizedKey, trimmed description, parsed salary) is
 * added once by enrichForStorage.
 */
export interface RawPosting {
  title: string;
  company: string;
  /** Every location the posting lists; empty when the source reports none. */
  locations: string[];
  link: string;
  source: string;
  /** ISO publication date from the source; absent when it reports none. */
  postedAt?: string;
  /** Plain text, already stripped of HTML. */
  description?: string;
  /** Only when the source states a season explicitly (SimplifyJobs README column). */
  season?: string[];
  /** Only when the source states compensation explicitly. */
  salary?: Salary;
}

/** A stored row. Mirrors the `internships` table. */
export interface Internship {
  id: string;           // md5(company + title + stripUtm(link))
  title: string;
  company: string;
  /** First listed location, for display. */
  location: string;
  locations: string[];
  metros: Metro[];
  description?: string;
  link: string;
  source: string;
  /** Publication date from the source; undefined when it gave none. */
  postedAt?: string;
  /** Last time any poller saw the row. */
  seenAt: string;
  /** When the tracker first stored the row. Never bumped. */
  firstSeenAt: string;
  score: number | null;
  /** null = never scored (test fixtures). */
  scoreLabel: ScoreLabel | null;
  matchedKeywords: string[];
  archived: boolean;
  /** 1 once a direct link check found the posting gone; rediscovery then leaves it archived. */
  failedCheckCount: number;
  lastCheckedAt?: string;
  salaryText?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryUnit?: Salary['unit'];
  /** Cross-source dedup key (company + normalized title). See normalize-key.ts. */
  normalizedKey: string;
  /** Season tokens like "summer-2027". Always at least one. */
  season: string[];
  /** Model classification. Absent until the row has been classified. */
  roleType?: RoleType;
  /** Eligible degree levels; empty array means the posting gave no signal. */
  degrees?: Degree[];
  usEligible?: 'yes' | 'no' | 'unclear';
  isInternship?: boolean;
  companyTier?: CompanyTier;
  classifiedAt?: string;
}

/**
 * Entry in data/ats-targets.json. The Workday-only fields (wd*) may also be
 * overlaid at runtime from the workday-flags sidecar (see ats.ts).
 */
export interface ATSTarget {
  slug: string;
  ats: 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'icims' | 'smartrecruiters' | 'rippling' | 'workable';
  name?: string;
  board?: string;             // Workday: job board path (e.g. 'NVIDIAExternalCareerSite')
  wdInstance?: string;        // Workday: wd1 (default), wd3, wd5, etc.
  wdDomain?: string;          // Workday: 'myworkdaysite.com' for site variant, default 'myworkdayjobs.com'
  wdCsrfRequired?: boolean;   // Workday: true when direct CXS API returns 422 (needs Playwright)
  wdSkipPlaywright?: boolean; // Workday: true when Playwright fallback has confirmed-failed
  /** Workday: cached intern facet IDs keyed by facet parameter. `{}` means
   *  discovery ran and found none (fall back to searchText='intern');
   *  `undefined` means discovery hasn't run. */
  wdInternFacets?: { [facetParameter: string]: string[] };
}
