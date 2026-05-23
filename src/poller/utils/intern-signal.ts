// What counts as an "intern" title across the codebase. Used by the hard
// filter (filter.ts) and the per-ATS pollers (ats.ts). Co-op is included
// because Cornell-relevant programs (SIG Trading Operations Co-op, etc.)
// use that term instead of "Intern".
//
// Word boundaries protect against false matches inside longer words —
// "cooperative", "coopt", "scoop" stay rejected. Numeric/email/UTM noise
// in nearby characters won't trigger either since \b only matches at
// word↔non-word transitions.
export const INTERN_SIGNAL_RE = /\b(intern(ship)?|co-?op)\b/i;

export function isInternTitle(title: string): boolean {
  return INTERN_SIGNAL_RE.test(title);
}
