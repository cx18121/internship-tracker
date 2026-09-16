import type { RawPosting } from '../lib/types';
import { classifyLocation } from './iso-locations';
import { INTERN_SIGNAL_RE } from './utils/intern-signal';
import { isExpiredSeasonTokens, deriveSeasonWithDefault } from '../lib/seasons';

const PHD_MASTERS_PATTERNS = [
  '🎓', 'phd', 'ph.d', 'doctoral', 'masters required', 'ms required',
  'graduate students only', 'graduate degree required',
  'mba', 'mba intern', 'mba student', 'master of business',
  'graduate intern', 'grad intern', 'masters student', 'ms student',
  'masters intern', 'ms intern'
];

const CLOSED_PATTERNS = [
  '🔒', 'position filled', 'no longer accepting', 'closed'
];

const NON_SWE_ROLES = [
  // Engineering disciplines that are not CS/SWE
  'hardware engineer', 'mechanical engineer', 'civil engineer', 'electrical engineer',
  'manufacturing engineer', 'aerospace engineer', 'mechanical aerospace',
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

// Short CS acronyms that need word-boundary protection (see above)
const CS_SIGNAL_EXACT_RE = /\b(sde|swe|ml|ai|cs)\b/i;

// Positive CS-signal stems — included terms indicate a CS/SWE role.
// IMPORTANT: "research" is NOT included here. "Research" in a title with "intern"
// is almost always a graduate research position, not a SWE internship.
// "scientist" is not included either — "Research Scientist" is a research track.
const CS_SIGNAL_STEMS = [
  'software', 'engineer', 'develop', 'data', 'backend', 'frontend',
  'full stack', 'full-stack', 'fullstack', 'system', 'infrastructure', 'platform',
  'security', 'devops', 'cloud', 'quant', 'technolog', 'web',
  'applicat', 'mobile', 'automat', 'cyber', 'network', 'database', 'analytic',
  'program', 'comput', 'science',
];

// Additional non-SWE title fragments that aren't caught by NON_SWE_ROLES.
// These check for "intern" + research-track modifiers that the stem check
// would otherwise allow to pass (because they contain "engineer" or "science").
const RESEARCH_INTERN_PATTERNS = [
  'research intern',       // "Research Intern" — graduate research, not SWE
  'graduate research',    // "Graduate Research Intern/Assistant"
  'research scientist',   // "Research Scientist Intern" — research track, not SWE
  'lab research',         // "Lab Research Intern"
  'computational research', // "Computational Research Intern"
  'undergraduate research', // "Undergraduate Research Intern"
  'scientific research',  // "Scientific Research Intern"
  'science research',     // "Science Research Intern"
  'research assistant',   // "Research Assistant Intern" (not a coding role)
];

export type ExclusionReason = 'non-us' | 'phd-required' | 'closed' | 'non-swe' | 'not-intern' | 'expired-season';

export const EXCLUSION_REASONS: readonly ExclusionReason[] = ['non-us', 'phd-required', 'closed', 'non-swe', 'not-intern', 'expired-season'];

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
  { reason: 'non-us',       rejects: ({ posting }) => classifyLocation(posting.location) === 'non_us' },
  { reason: 'not-intern',   rejects: ({ posting }) => !INTERN_SIGNAL_RE.test(posting.title) },
  // Research-track blocks override the CS-signal allowlist below: "Research
  // Intern" contains "research" which isn't a CS stem, but it could still
  // contain "engineer" or "science" via "research engineer" / "research
  // scientist" so we'd miss them without this rule firing first.
  { reason: 'non-swe',      rejects: ({ titleLower }) => RESEARCH_INTERN_PATTERNS.some((p) => titleLower.includes(p)) },
  { reason: 'non-swe',      rejects: ({ titleLower }) => NON_SWE_ROLES.some((r) => titleLower.includes(r)) },
  // PhD gate runs before cs_signal so "PhD Software Engineer Intern" gets
  // bounced even though it has strong CS signals.
  { reason: 'phd-required', rejects: ({ combined }) => PHD_MASTERS_PATTERNS.some((p) => combined.includes(p.toLowerCase())) },
  // Positive allowlist: must contain a recognized CS/SWE signal. "sde" is
  // included for Software Development Engineer intern titles.
  { reason: 'non-swe',      rejects: ({ titleLower, posting }) =>
      !CS_SIGNAL_STEMS.some((s) => titleLower.includes(s)) &&
      !CS_SIGNAL_EXACT_RE.test(posting.title) },
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
    combined: `${titleLower} ${posting.location.toLowerCase()}`,
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
