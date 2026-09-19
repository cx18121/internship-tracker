import type { ATSTarget, RawPosting } from '../../lib/types';

export type ATSKind = ATSTarget['ats'];
export type LinkState = 'live' | 'gone' | 'unknown';

/** A posting's identity on its hiring system: board (tenant) slug plus job id. */
export interface JobRef {
  slug: string;
  jobId: string;
}

/** What the tracker can do with a link to a hiring system or feed. */
export interface LinkHandler {
  /** Both arguments lowercased by the registry. */
  matchUrl(hostname: string, pathname: string): boolean;
  /** Null for a board landing page or a link with no job id. */
  jobFromUrl(url: URL): JobRef | null;
  /** Job description text, '' when unavailable. */
  describe?(job: JobRef, url: string): Promise<string>;
  /** Whether the job still exists. Omit when only an HTTP status check is possible. */
  alive?(job: JobRef, url: string): Promise<LinkState>;
}

/** Everything the tracker knows about one ATS, in one module. */
export interface Ats extends LinkHandler {
  kind: ATSKind;
  /** Source label written on rows polled from this ATS. */
  source: string;
  /** Board descriptor from any link on this ATS, for data/ats-targets.json. */
  targetFromUrl(hostname: string, pathname: string): Omit<ATSTarget, 'name'> | null;
  /** Does a public board exist for this slug? Used by discovery. */
  boardExists?(slug: string, timeoutMs?: number): Promise<boolean>;
  /** Intern postings on one board. Workday is orchestrated separately and omits this. */
  poll?(target: ATSTarget, now: string): Promise<RawPosting[]>;
}
