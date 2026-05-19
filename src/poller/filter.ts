import { Internship } from '../lib/types';

// Known US cities that share names with international locations — exclude from international flagging
const US_CITY_AMBIGUITY_MAP: Record<string, boolean> = {
  'moscow, id': true, 'moscow, idaho': true,
  'boise, id': true, 'nampa, id': true,
  'lake zurich, il': true,
  'manchester, nh': true, 'manchester, ct': true,
  'dublin, oh': true, 'dublin, or': true,
  'vienna, va': true, 'vienna, ny': true,
  'paris, ky': true, 'paris, id': true,
  'berlin, nh': true, 'berlin, wi': true,
  'london, ky': true, 'london, oh': true,
  'athens, ga': true, 'athens, oh': true,
  'cairo, il': true,
  'cambridge, ma': true, 'cambridge, md': true,
  'spring, tx': true, 'spring, il': true,
  'newcastle, de': true,
};

function isAmbiguousUSLocation(loc: string): boolean {
  return loc in US_CITY_AMBIGUITY_MAP;
}

const NON_US_LOCATIONS = [
  // Full country / region names
  'canada', 'uk', 'united kingdom', 'ireland', 'germany', 'france',
  'india', 'japan', 'australia', 'netherlands', 'sweden', 'switzerland',
  'singapore', 'china', 'new zealand', 'austria', 'denmark', 'finland',
  'norway', 'belgium', 'brussels', 'luxembourg',
  // Specific international cities (without US state suffix)
  'bangalore', 'shanghai', 'beijing', 'hong kong', 'shenzhen',
  'warsaw', 'paris', 'paris,', 'berlin', 'tokyo', 'seoul', 'sydney', 'melbourne',
  'amsterdam', 'prague', 'budapest', 'munich', 'frankfurt', 'zurich', 'geneva', 'vienna at',
  'london', 'london,', 'london uk', 'manchester uk', 'edinburgh', 'toronto',
  'dublin uk',
  'bogota', 'buenos aires', 'lima', 'santiago', 'jakarta', 'manila',
  'bangkok', 'kuala lumpur', 'taiwan', 'tel aviv', 'herzliya',
  // Remote-prefixed international
  'remote - poland', 'remote - india', 'remote - germany', 'remote - uk',
  'remote - ireland', 'remote - australia', 'remote - japan', 'remote - singapore',
  'remote in canada',
  // Country codes that appear in location strings (2-letter ISO, uppercase or lowercase after comma-space)
  // These are checked after splitting on comma; US state codes are filtered out
];

function isNonUSCountryCode(code: string): boolean {
  const nonUS = ['cn', 'pl', 'mx', 'br', 'kr', 'jp', 'au', 'nz', 'sg', 'my', 'th', 'id', 'vn', 'ph', 'tw', 'in', 'pk', 'bd', 'np', 'lk', 'mm', 'kh', 'la', 'mm', 'kh'];
  return nonUS.includes(code.toLowerCase());
}

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

const INTERN_SIGNAL_RE = /\bintern(ship)?\b/i;

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
  const locationLower = (internship.location || '').toLowerCase();
  const titleLower = (internship.title || '').toLowerCase();
  const combined = `${titleLower} ${locationLower}`;

  // If location is unknown/empty, pass — keep unconfirmed locations for manual review.
  if (!internship.location || internship.location.trim() === '') {
    // Treat as passing.
  } else if (!isAmbiguousUSLocation(locationLower)) {
    // Check non-US location substrings
    for (const loc of NON_US_LOCATIONS) {
      if (locationLower.includes(loc)) {
        return { passed: false, reason: 'non_us' };
      }
    }
    // Check country-code suffixes (e.g. "Shanghai, CN", "Mexico City, MX")
    const parts = (internship.location || '').split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length === 2 && isNonUSCountryCode(trimmed)) {
        return { passed: false, reason: 'non_us' };
      }
    }
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
