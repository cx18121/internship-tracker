// Smart-trim ATS descriptions for storage. Pollers slice raw HTML at ~4000
// chars so the scorer can see tech keywords from anywhere in the body; this
// module then runs AFTER scoring to shrink the persisted description down
// to a UI-friendly size by:
//   1. Detecting company-marketing openers ("Who We Are", "Join us at X",
//      "[Company] is a global leader…") and skipping to the first role
//      section heading so the stored body starts at the actual role content.
//   2. Cutting trailing benefits/EEO/legal/meta sections that contribute no
//      role information.
//   3. Capping the result at a maxLen char ceiling, preferring a sentence
//      boundary just before the cap.
//
// The preamble skip is gated on a marketing-opener match — substantive
// intros that happen to start with "About the Opportunity" / "Job
// Description:" / "We are seeking…" are NOT matched, so they pass through
// untouched. False-positive risk: if the opener pattern matches but the
// description has no clear section heading, the skip is a no-op (we keep
// the full original).

const DEFAULT_MAX = 2000;
const MIN_END_MARKER_POS = 300;

// Handshake's mobile-app promo banner ("Describe your goals, preferences,
// or background, and we'll find the best jobs tailored to you. Everything
// the website does for on-the-go career support. Plus reminders so you
// never miss a thing.") sits inside the [data-hook="job-details-page"]
// wrapper and gets captured as part of the description. Word-for-word
// stable across postings. Exported as a regex *source* so the in-browser
// page.evaluate context (handshake.ts) and the cleanup-script backfill
// can both build their own RegExp from one source-of-truth pattern.
export const HANDSHAKE_PROMO_BANNER_SOURCE =
  "Describe your goals, preferences, or background, and we'll find the best jobs tailored to you\\.\\s*Everything the website does for on-the-go career support\\.\\s*Plus reminders so you never miss a thing\\.?";
// Marketing prefixes can be long — Workday and Greenhouse postings frequently
// run 1500-1700 chars of company pitch before the role section. Allow skip
// up to this many chars; beyond that, the description is mostly marketing
// and there's nothing useful to recover.
const MAX_PREAMBLE_SKIP = 1800;
const MIN_SECTION_POS = 200;

// Patterns that signal the description opens with company marketing.
// Matched against the first 250 chars only — real openers show up early.
const MARKETING_OPENERS: readonly RegExp[] = [
  /^\s*Who\s+[Ww]e\s+[Aa]re\b/,
  /^\s*About\s+(?:Us|Our\s+(?:Company|Team)|This\s+Company)\b/i,
  /^\s*Join\s+us\s+at\b/i,
  /^\s*Join\s+Our\s+Team\b/i,
  /^\s*Welcome\s+to\b/i,
  // "At [Company], we [verb]…" — company-led marketing intro.
  /^\s*At\s+[A-Z]\w+(?:\s+[A-Z]\w+)?[,]?\s+we\s+(?:are|believe|build|do|empower|enable|exist|invest|live|love|make|put|see|solve|strive|think|value|work)/,
  // "[Company] is a [adj] [type]" — third-person company description.
  /^\s*[A-Z]\w+(?:\s+\w+){0,2}\s+is\s+(?:a|the|an)\s+(?:global\s+|leading\s+|world(?:'s|-class)?\s+|fast-growing\s+|pioneering\s+)?(?:leader|provider|company|technology\s+company|platform|software\s+company|world|pioneer|innovator|developer|manufacturer)\b/i,
  // "[Company] is committed to / dedicated to / passionate about"
  /^\s*[A-Z]\w+(?:\s+\w+){0,2}\s+is\s+(?:committed|dedicated|passionate|driven|focused)\b/i,
  // "Our/Company's mission"
  /^\s*(?:Our|[A-Z]\w+'s)\s+mission\b/i,
];

// Section headings that introduce the actual role description. Matched
// case-insensitively with a leading section-boundary (newline or sentence
// terminator), so casual mid-sentence mentions of "responsibilities" can't
// trip the skip — the boundary check is what's protecting us, not casing.
const ROLE_SECTION_HEADINGS: readonly string[] = [
  'Role & Responsibilities',
  'Key Responsibilities',
  'Main Responsibilities',
  'Job Responsibilities',
  'Responsibilities will include',
  'Job Description',
  'Job Summary',
  'Job Purpose',
  'Job Overview',
  'Position Summary',
  'Position Overview',
  'Position Description',
  'Position Purpose',
  'Role Overview',
  'Role Description',
  'Role Summary',
  'Team Overview',
  'About the Role',
  'About the Position',
  'About the Job',
  'About the Internship',
  'About the Opportunity',
  'About this Role',
  'About this Position',
  'About this Internship',
  'Internship Program',
  'Internship Description',
  'Internship Overview',
  'Internship Summary',
  'Scope of Training',
  'Overview of the Role',
  'The Role',
  'The Opportunity',
  "What you'll do",
  'What you will do',
  'In this role',
  'In this position',
  'In this internship',
  'Your Mission',
  'Your Role',
  'Day-to-Day',
  'Day to Day',
];

// Regexes that mark the END of useful job-description content. Anything from
// the first match onward gets dropped. Each pattern requires a section-style
// boundary (start of line, sentence terminator, or paragraph break) so a
// passing mention of "benefits" mid-sentence won't trim the whole body.
//
// Ordered conceptually but the impl picks the EARLIEST match across all of
// them, so order doesn't change behavior.
// Only ALL-CAPS variants of benefits headers — title-case "What We Offer" /
// "Benefits Package" fire too often mid-description (e.g. Applied Materials
// puts a "What We Offer Location: ..." block BEFORE the actual TEAM OVERVIEW
// section). The all-caps form is a real section divider; the title-case form
// is too ambiguous.
const END_MARKERS: readonly RegExp[] = [
  // EEO / posting statements (always tail, never mid-content)
  /(?:^|[.!?]\s|\n)\s*(?:Posting Statement|Equal (?:Opportunity|Employment))/i,
  /(?:^|[.!?]\s|\n)\s*EEO\s+Statement\b/,
  /(?:^|[.!?]\s|\n)\s*All qualified applicants will receive consideration\b/i,
  // Why-work / culture sections
  /(?:^|[.!?]\s|\n)\s*Why (?:work|join) (?:for|at|with|us)\b/i,
  // ALL-CAPS benefits headers only — these mark the actual end of role content
  /(?:^|[.!?]\s|\n)\s*WHAT WE OFFER\s*[:\n]/,
  /(?:^|[.!?]\s|\n)\s*BENEFITS\s*[:\n]/,
  /(?:^|[.!?]\s|\n)\s*OUR BENEFITS\s*[:\n]/,
  /(?:^|[.!?]\s|\n)\s*PERKS\s*[:&]/,
  // Pay transparency disclosures (legal boilerplate; salary already parsed
  // by parseSalary upstream from the full description)
  /(?:^|[.!?]\s|\n)\s*Pay Transparency\b/i,
  /(?:^|[.!?]\s|\n)\s*The (?:hourly|salary) range (?:information|estimate|for this)/i,
  // AI / hiring process policies
  /(?:^|[.!?]\s|\n)\s*Artificial Intelligence \(AI\) (?:Policy|Use)/i,
  /(?:^|[.!?]\s|\n)\s*AI (?:Tools? )?Policy\b/i,
  // Background / drug / accommodation legal
  /(?:^|[.!?]\s|\n)\s*(?:Criminal )?Background Check\b/i,
  /(?:^|[.!?]\s|\n)\s*Drug (?:Screen|Test)\b/i,
  /(?:^|[.!?]\s|\n)\s*Accessibility (?:and|&) Accommodations?\b/i,
  // Workday meta tail — "Job Type: Student / Intern Shift: Shift 1..."
  // through "Primary Location" and "Business group" boilerplate
  /(?:^|[.!?]\s|\n)\s*Job Type\s*:\s*(?:Student|Intern|Internship|Regular)/i,
  /(?:^|[.!?]\s|\n)\s*Primary Location\s*:/i,
  /(?:^|[.!?]\s|\n)\s*Additional Locations\s*:/i,
  /(?:^|[.!?]\s|\n)\s*Business [Gg]roup\s*:/i,
  // Security / phishing notices
  /(?:^|[.!?]\s|\n)\s*Security Notice\s*:/i,
  /(?:^|[.!?]\s|\n)\s*will never request sensitive/i,
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeMarketingOpener(text: string): boolean {
  const head = text.slice(0, 250);
  return MARKETING_OPENERS.some(re => re.test(head));
}

// Single alternation regex over all role-section headings. Built once at
// module load (precompiled), case-insensitive. The capture group isolates
// the heading itself so callers can locate it after the boundary prefix.
const ROLE_SECTION_RE = new RegExp(
  `(?:^|[.!?]\\s+|\\n)\\s*(${ROLE_SECTION_HEADINGS.map(escapeRegex).join('|')})`,
  'gi',
);

/**
 * Find the earliest position of a role-section heading at or after minPos.
 * Headings must sit at a section boundary (start, newline, or sentence
 * terminator) — a casual mention of "responsibilities" inside a sentence
 * is ignored.
 */
function findRoleSectionStart(text: string, minPos: number): number {
  ROLE_SECTION_RE.lastIndex = 0;
  let earliest = -1;
  let m: RegExpExecArray | null;
  while ((m = ROLE_SECTION_RE.exec(text)) !== null) {
    const headingPos = m.index + m[0].indexOf(m[1]);
    if (headingPos >= minPos) {
      // The regex scans left-to-right, so the first match at/after minPos
      // is the earliest by construction — short-circuit and return.
      earliest = headingPos;
      break;
    }
  }
  return earliest;
}

/**
 * Trim ATS description for storage. Pipeline:
 *   1. If the description opens with company-marketing language AND a
 *      role-section heading appears within the first MAX_PREAMBLE_SKIP
 *      chars, slice from the heading (drop "About Us" preamble).
 *   2. Drop trailing benefits/EEO/legal tail at the earliest END_MARKERS hit.
 *   3. Cap at maxLen chars, preferring a sentence boundary just before
 *      the cap to avoid mid-word cuts.
 * Empty input returns ''.
 */
export function smartTrimDescription(text: string | null | undefined, maxLen: number = DEFAULT_MAX): string {
  if (!text) return '';
  let result = text;

  // 1. Marketing-preamble skip.
  if (looksLikeMarketingOpener(result)) {
    const sectionStart = findRoleSectionStart(result, MIN_SECTION_POS);
    if (sectionStart > 0 && sectionStart <= MAX_PREAMBLE_SKIP) {
      result = result.slice(sectionStart);
    }
  }

  // 2. End-trim — drop benefits/EEO/legal tail.
  let earliestEnd = -1;
  for (const re of END_MARKERS) {
    const m = result.match(re);
    if (m?.index != null && m.index >= MIN_END_MARKER_POS) {
      if (earliestEnd === -1 || m.index < earliestEnd) {
        earliestEnd = m.index;
      }
    }
  }
  if (earliestEnd > 0) {
    result = result.slice(0, earliestEnd);
  }

  // 3. Cap with sentence-boundary preference.
  result = result.replace(/\s+$/, '');
  if (result.length > maxLen) {
    const sliceWindow = result.slice(0, maxLen);
    const lastBoundary = Math.max(
      sliceWindow.lastIndexOf('. '),
      sliceWindow.lastIndexOf('! '),
      sliceWindow.lastIndexOf('? '),
      sliceWindow.lastIndexOf('.\n'),
    );
    if (lastBoundary >= maxLen - 200) {
      result = result.slice(0, lastBoundary + 1);
    } else {
      result = sliceWindow;
    }
  }

  return result.trim();
}
