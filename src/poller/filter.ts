import { Internship } from '../lib/types';
import { classifyLocation } from './iso-locations';
import { INTERN_SIGNAL_RE } from './utils/intern-signal';

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

export type ExclusionReason = 'non_us' | 'phd_required' | 'closed' | 'non_swe' | 'not_intern';

export interface FilterResult {
  passed: boolean;
  reason?: ExclusionReason;
}

interface FilterContext {
  internship: Partial<Internship>;
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
// "London engineer" should report 'non_us', not 'not_intern'.
const RULES: readonly Rule[] = [
  // Empty/ambiguous locations come back as 'unknown' from classifyLocation
  // and pass — manual review beats blanket-rejecting unstructured strings.
  { reason: 'non_us',       rejects: ({ internship }) => classifyLocation(internship.location || '') === 'non_us' },
  { reason: 'not_intern',   rejects: ({ internship }) => !INTERN_SIGNAL_RE.test(internship.title || '') },
  // Research-track blocks override the CS-signal allowlist below: "Research
  // Intern" contains "research" which isn't a CS stem, but it could still
  // contain "engineer" or "science" via "research engineer" / "research
  // scientist" so we'd miss them without this rule firing first.
  { reason: 'non_swe',      rejects: ({ titleLower }) => RESEARCH_INTERN_PATTERNS.some((p) => titleLower.includes(p)) },
  { reason: 'non_swe',      rejects: ({ titleLower }) => NON_SWE_ROLES.some((r) => titleLower.includes(r)) },
  // PhD gate runs before cs_signal so "PhD Software Engineer Intern" gets
  // bounced even though it has strong CS signals.
  { reason: 'phd_required', rejects: ({ combined }) => PHD_MASTERS_PATTERNS.some((p) => combined.includes(p.toLowerCase())) },
  // Positive allowlist: must contain a recognized CS/SWE signal. "sde" is
  // included for Software Development Engineer intern titles.
  { reason: 'non_swe',      rejects: ({ titleLower, internship }) =>
      !CS_SIGNAL_STEMS.some((s) => titleLower.includes(s)) &&
      !CS_SIGNAL_EXACT_RE.test(internship.title || '') },
  { reason: 'closed',       rejects: ({ combined }) => CLOSED_PATTERNS.some((p) => combined.includes(p.toLowerCase())) },
];

export function applyHardFilters(internship: Partial<Internship>): FilterResult {
  const titleLower = (internship.title || '').toLowerCase();
  const locationLower = (internship.location || '').toLowerCase();
  const ctx: FilterContext = {
    internship,
    titleLower,
    combined: `${titleLower} ${locationLower}`,
  };
  for (const rule of RULES) {
    if (rule.rejects(ctx)) return { passed: false, reason: rule.reason };
  }
  return { passed: true };
}

export interface FilterCounts {
  excludedNonUS: number;
  excludedPhDRequired: number;
  excludedClosed: number;
  excludedNonSWE: number;
  excludedNotIntern: number;
}

export function filterInternships(
  internships: Partial<Internship>[]
): { passed: Partial<Internship>[]; counts: FilterCounts } {
  const counts: FilterCounts = {
    excludedNonUS: 0,
    excludedPhDRequired: 0,
    excludedClosed: 0,
    excludedNonSWE: 0,
    excludedNotIntern: 0,
  };

  const passed: Partial<Internship>[] = [];

  for (const i of internships) {
    const result = applyHardFilters(i);
    if (result.passed) {
      passed.push(i);
    } else {
      if (result.reason === 'non_us') counts.excludedNonUS++;
      if (result.reason === 'phd_required') counts.excludedPhDRequired++;
      if (result.reason === 'closed') counts.excludedClosed++;
      if (result.reason === 'non_swe') counts.excludedNonSWE++;
      if (result.reason === 'not_intern') counts.excludedNotIntern++;
    }
  }

  return { passed, counts };
}
