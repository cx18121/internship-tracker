import type { RawPosting } from '../lib/types';
import { classifyLocation } from './iso-locations';
import { INTERN_SIGNAL_RE } from './utils/intern-signal';
import { isExpiredSeasonTokens, deriveSeasonWithDefault } from '../lib/seasons';

const CLOSED_PATTERNS = [
  '🔒', 'position filled', 'no longer accepting', 'closed'
];

const NON_SWE_ROLES = [
  // Engineering disciplines far from CS. Hardware and electrical stay in and
  // are tagged hardware_ee by the classifier.
  'mechanical engineer', 'civil engineer', 'manufacturing engineer', 'aerospace engineer', 'mechanical aerospace',
  // Business/ops functions
  'operations intern', 'operation support', 'operations support',
  'accounting intern', 'finance intern', 'financial intern',
  'marketing intern', 'marketing analytics', 'social media intern', 'social media internship',
  'sales intern', 'sales development', 'business development intern',
  'hr intern', 'human resources intern', 'recruiter',
  // Other non-technical
  'instructional design', 'supply chain intern', 'logistics intern',
  'communications intern', 'policy intern', 'legal intern',
  // Marketing variants
  'product marketing', 'marketing &', 'media process', 'product line intern',
  // Sales/GTM
  'sales/gtm', 'gtm',
  // Finance/investment
  'investment research',
  // Operations
  'mission operations', 'global operations',
];

export type ExclusionReason = 'non-us' | 'closed' | 'non-swe' | 'not-intern' | 'expired-season';

export const EXCLUSION_REASONS: readonly ExclusionReason[] = ['non-us', 'closed', 'non-swe', 'not-intern', 'expired-season'];

export interface FilterResult {
  passed: boolean;
  reason?: ExclusionReason;
}

interface FilterContext {
  posting: RawPosting;
  titleLower: string;
  combined: string;
}

interface Rule {
  reason: ExclusionReason;
  /** Returns true when the rule rejects the internship. */
  rejects: (ctx: FilterContext) => boolean;
}

// Order matters: the first rejecting rule wins. Tier-order chosen to surface
// the most specific reason — e.g. non-US wins over not-intern because
// "London engineer" should report 'non-us', not 'not-intern'.
const RULES: readonly Rule[] = [
  // Empty/ambiguous locations come back as 'unknown' from classifyLocation
  // and pass — manual review beats blanket-rejecting unstructured strings.
  { reason: 'non-us',       rejects: ({ posting }) => posting.locations.length > 0 && posting.locations.every(l => classifyLocation(l) === 'non_us') },
  { reason: 'not-intern',   rejects: ({ posting }) => !INTERN_SIGNAL_RE.test(posting.title) },
  // Obvious non-technical titles are dropped here so they never cost a
  // classifier call. Everything else is kept and the classifier decides role
  // type and degree eligibility.
  { reason: 'non-swe',      rejects: ({ titleLower }) => NON_SWE_ROLES.some((r) => titleLower.includes(r)) },
  { reason: 'closed',       rejects: ({ combined }) => CLOSED_PATTERNS.some((p) => combined.includes(p.toLowerCase())) },
  // Runs last: only an otherwise-valid SWE intern role gets tagged 'expired-season',
  // so the count reflects genuinely-missed roles rather than e.g. expired non-SWE.
  // The off-season list carries many past cycles (Summer 2024, Winter 2026, …).
  { reason: 'expired-season', rejects: ({ posting }) => isExpiredSeasonTokens(posting.season ?? deriveSeasonWithDefault(posting.title)) },
];

export function applyHardFilters(posting: RawPosting): FilterResult {
  const titleLower = posting.title.toLowerCase();
  const ctx: FilterContext = {
    posting,
    titleLower,
    combined: `${titleLower} ${posting.locations.join(' ').toLowerCase()}`,
  };
  for (const rule of RULES) {
    if (rule.rejects(ctx)) return { passed: false, reason: rule.reason };
  }
  return { passed: true };
}

export type ExclusionCounts = Record<ExclusionReason, number>;

export function filterPostings(postings: RawPosting[]): { passed: RawPosting[]; excluded: ExclusionCounts } {
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map(r => [r, 0])) as ExclusionCounts;
  const passed: RawPosting[] = [];
  for (const p of postings) {
    const result = applyHardFilters(p);
    if (result.passed) passed.push(p);
    else excluded[result.reason!]++;
  }
  return { passed, excluded };
}
