export interface Internship {
  id: string;           // MD5(company + title + link)
  title: string;
  company: string;
  location: string;
  description?: string; // Job description text (when available)
  link: string;
  source: string;       // SimplifyJobs | RemoteOK | Handshake
  atsSource?: string;   // greenhouse | lever | workday | icims | ashby | unknown
  /** Job ID as given by the ATS portal (e.g. "4829100123" from a Greenhouse board URL). Used for portal disappearance detection. */
  atsJobId?: string;
  /** Slug of the ATS target in ats-targets.json that matched this listing. */
  atsTarget?: string;
  postedAt: string;
  seenAt: string;
  score: number | null;
  scoreLabel: string;   // Excellent | Strong | Good | Low
  matchedKeywords: string[];
  isNew: boolean;
  applied: boolean;
  archived?: boolean;
  appliedAt?: string;
  /**
   * Link revalidation metadata.
   * Policy: 404/410/451 on first check → archive immediately.
   * Transient failures (403, 429, 5xx) → don't increment count.
   * Successful check → reset failedCheckCount to 0.
   */
  failedCheckCount?: number;   // 0 = last check passed; incremented each consecutive failure
  firstFailedAt?: string;      // ISO timestamp of first failure (resets when check passes)
  lastCheckedAt?: string;      // ISO timestamp of last HTTP revalidation check
  applicationUrl?: string;
  applicationStatus?: string; // not_applied, applied, interviewing, rejected, offered
  /** Set when this entry covers multiple locations (e.g. SimplifyJobs "N locationsCity1, STCity2, ST...") */
  multiLocation?: string[];
  /** Parsed salary info. Populated by src/lib/salary.ts when ingesting. */
  salaryText?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryUnit?: 'hourly' | 'monthly' | 'yearly';
  /** Cross-source dedup key (company + normalized title). See src/lib/normalize-key.ts. */
  normalizedKey?: string;
  /** Hidden from UI + alerts via the Discord ❌ Not interested button. */
  hidden?: boolean;
}

export interface CycleStats {
  timestamp: string;
  sourcesPolled: string[];
  rawFetched: number;
  excludedNonUS: number;
  excludedPhDRequired: number;
  excludedClosed: number;
  excludedNonSWE: number;
  newScored: number;
  sent: number;
}
