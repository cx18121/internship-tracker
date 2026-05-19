/**
 * Cross-source dedup key — normalizes (company, title) so the same role
 * posted by multiple boards (Greenhouse + Indeed + SimplifyJobs) collapses
 * to one record.
 *
 * Tradeoffs:
 *   - More aggressive normalization = more cross-source merges, but more
 *     false positives (two distinct internships at the same company that
 *     happen to share a base title get merged).
 *   - This implementation errs CONSERVATIVE: strip obvious clutter
 *     (parenthesized text, year markers, location suffixes, "intern"
 *     word) but keep distinguishing terms like "ML", "Frontend",
 *     "Security", etc.
 *
 * Examples:
 *   ("Stripe", "Software Engineer Intern, Summer 2025 (Remote)")
 *     → "stripe::software engineer"
 *   ("Stripe", "Software Engineer Intern")
 *     → "stripe::software engineer"   ✓ matches
 *   ("Stripe", "Backend Engineer Intern")
 *     → "stripe::backend engineer"    ✗ correctly distinct
 */

const FILLER_WORDS = new Set([
  // Position type
  'intern', 'interns', 'internship', 'internships',
  'co-op', 'coop', 'co', 'op',
  'apprentice', 'apprenticeship',
  'trainee',

  // Term markers
  'summer', 'spring', 'fall', 'autumn', 'winter',
  '2023', '2024', '2025', '2026', '2027', '2028', '2029', '2030',

  // Schedule modifiers
  'full-time', 'fulltime', 'parttime', 'part-time',
  'temporary', 'temp', 'seasonal',

  // Work location modifiers (when standalone)
  'remote', 'hybrid', 'onsite', 'on-site',

  // Common stop-words that shouldn't differentiate
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'with',
  'i', 'ii', 'iii', 'iv',
]);

export function normalizeKey(company: string, title: string): string {
  const cleanedTitle = title
    .toLowerCase()
    // Drop parenthesized / bracketed content first
    .replace(/\(.*?\)/g, ' ')
    .replace(/\[.*?\]/g, ' ')
    // Drop "- Remote", ", NYC", "— Summer 2025" tail clauses
    .replace(/[\-–—,/]\s*(remote|hybrid|onsite|on[-\s]?site|nyc|sf|ny|new\s+york|san\s+francisco|seattle|boston|austin|chicago|los\s+angeles|us|usa|united\s+states|summer|spring|fall|winter|\d{4}).*$/i, '')
    // Punctuation → spaces
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    // Collapse, split, filter, rejoin
    .split(/\s+/)
    .filter(w => w && !FILLER_WORDS.has(w))
    .join(' ')
    .trim();

  return `${company.toLowerCase().trim()}::${cleanedTitle}`;
}
