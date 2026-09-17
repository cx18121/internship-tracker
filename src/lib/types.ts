import type { Salary } from './salary';
import type { RoleType, Degree } from './classify/posting';
import type { CompanyTier } from './classify/company';

export type ScoreLabel = 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * One listing as a poller reports it. Everything derived (id, score,
 * default season, normalizedKey, trimmed description, parsed salary) is
 * added once by enrichForStorage.
 */
export interface RawPosting {
  title: string;
  company: string;
  /** '' when the source reports no location. */
  location: string;
  link: string;
  source: string;
  /** ISO timestamp. Poll time when the source reports no publication date. */
  postedAt: string;
  /** Plain text, already stripped of HTML. */
  description?: string;
  /** Only when the source states a season explicitly (SimplifyJobs README column). */
  season?: string[];
  /** Only when the source states compensation explicitly (Handshake card). */
  salary?: Salary;
  multiLocation?: string[];
}

/** A stored row. Mirrors the `internships` table. */
export interface Internship {
  id: string;           // md5(company + title + stripUtm(link))
  title: string;
  company: string;
  location: string;
  description?: string;
  link: string;
  source: string;
  postedAt: string;
  seenAt: string;
  score: number | null;
  /** null = never scored (test fixtures). */
  scoreLabel: ScoreLabel | null;
  matchedKeywords: string[];
  applied: boolean;
  appliedAt?: string;
  hidden: boolean;
  archived: boolean;
  /**
   * Link revalidation. 404/410/451/401 on check → archive. Transient
   * failures (403, 429, 5xx) don't increment. A passing check resets to 0.
   */
  failedCheckCount: number;
  firstFailedAt?: string;
  lastCheckedAt?: string;
  multiLocation?: string[];
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
