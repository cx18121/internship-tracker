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

export interface FilterResult {
  passed: boolean;
  reason?: 'non_us' | 'phd_required' | 'closed' | 'non_swe' | 'not_intern';
}

export function applyHardFilters(internship: Partial<Internship>): FilterResult {
  const titleLower = (internship.title || '').toLowerCase();
  const locationLower = (internship.location || '').toLowerCase();
  const combined = `${titleLower} ${locationLower}`;

  // Location classification: 'us' / 'non_us' / 'unknown'. Empty or genuinely
  // ambiguous locations come back as 'unknown' and pass — keep them for
  // manual review rather than blanket-rejecting unstructured strings.
  if (classifyLocation(internship.location || '') === 'non_us') {
    return { passed: false, reason: 'non_us' };
  }

  // Require "intern" or "internship" in the title for every source.
  if (!INTERN_SIGNAL_RE.test(internship.title || '')) {
    return { passed: false, reason: 'not_intern' };
  }

  // Research-track blocks: "Research Intern", "Graduate Research", "Research Scientist"
  // and similar combinations are almost never SWE roles, even when they contain
  // "engineer" or "science" — the surrounding context makes them non-SWE.
  for (const p of RESEARCH_INTERN_PATTERNS) {
    if (titleLower.includes(p)) {
      return { passed: false, reason: 'non_swe' };
    }
  }

  // Check non-SWE roles
  for (const role of NON_SWE_ROLES) {
    if (titleLower.includes(role)) {
      return { passed: false, reason: 'non_swe' };
    }
  }

  // Check PhD/Masters required (check title and company description)
  // Runs before cs_signal to block "PhD Software Engineer Intern" even though it
  // has strong CS signals — PhD-track roles are rejected regardless of title keywords.
  for (const pattern of PHD_MASTERS_PATTERNS) {
    if (combined.includes(pattern.toLowerCase())) {
      return { passed: false, reason: 'phd_required' };
    }
  }

  // CS-signal allowlist: if the title has no recognizable CS/SWE signals, reject.
  // This catches non-technical roles that slip past the NON_SWE_ROLES keyword list.
  // "sde" is included for Software Development Engineer intern titles (e.g. "SDE Intern").
  const hasCSSignal =
    CS_SIGNAL_STEMS.some(s => titleLower.includes(s)) ||
    CS_SIGNAL_EXACT_RE.test(internship.title || '');
  if (!hasCSSignal) {
    return { passed: false, reason: 'non_swe' };
  }

  // Check closed/filled
  for (const pattern of CLOSED_PATTERNS) {
    if (combined.includes(pattern.toLowerCase())) {
      return { passed: false, reason: 'closed' };
    }
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
