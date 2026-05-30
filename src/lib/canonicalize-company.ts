/**
 * Canonicalize a company name so the SAME company posted under slightly
 * different names by different sources collapses to one.
 *
 * The cross-source dedup key (see normalize-key.ts) and the by-company
 * grouping both key off this output, so "NVIDIA" and "NVIDIA AI" merging
 * here is what stops the same role appearing twice.
 *
 * Two layers, in order:
 *   1. ALGORITHMIC — strip trailing parenthetical tags ("(AWS)", "(SRA)")
 *      and legal-entity suffixes (", Inc.", " LLC", " Corporation", …).
 *      This is conservative: a suffix only matches as a whole trailing
 *      token after a separator, so "Costco" never loses "co".
 *   2. CURATED ALIASES — a small hand-maintained map for branded variants
 *      that carry NO legal suffix to strip ("NVIDIA AI" → "NVIDIA",
 *      "Adobe Systems" → "Adobe"). These are explicit because algorithmic
 *      "AI"/"Systems" stripping would wrongly merge distinct companies
 *      (e.g. "Character AI" → "Character").
 *
 * Idempotent: canonicalizeCompany(canonicalizeCompany(x)) === canonicalizeCompany(x).
 */

// Legal-entity suffix tokens. Matched as a whole trailing token preceded by
// a comma and/or whitespace, with optional internal/trailing periods, so
// "Inc", "Inc.", ", Inc." and "N.A." all match while "Costco" does not.
const SUFFIX_RE = /[,]?\s+(?:inc|incorporated|llc|l\.l\.c|corp|corporation|ltd|limited|co|company|gmbh|plc|llp|lp|pty|n\.?a)\.?$/i;

// Branded variants with no strippable legal suffix. Keys are the lowercased,
// algorithmically-cleaned (paren+suffix-stripped) form; values are the
// canonical display name. Keep this tight — every entry is an explicit
// "these are the same company" decision.
const ALIASES = new Map<string, string>([
  ['nvidia ai', 'NVIDIA'],
  ['perplexity ai', 'Perplexity'],
  ['adobe systems', 'Adobe'],
  ['amazon.com', 'Amazon'],
  ['amazon web services', 'Amazon'],
  ['amazon science', 'Amazon'],
  ['caci international', 'CACI'],
  ['palantir technologies', 'Palantir'],
]);

export function canonicalizeCompany(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return '';

  // 1a. Strip trailing parenthetical tags, repeatedly ("Foo (X) (Y)").
  let prev: string;
  do {
    prev = name;
    name = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  } while (name !== prev && name);

  // 1b. Strip trailing legal-entity suffixes, repeatedly
  // ("Al Warren Oil Company, Inc." → "Al Warren Oil Company" → "Al Warren Oil").
  do {
    prev = name;
    name = name.replace(SUFFIX_RE, '').trim();
  } while (name !== prev && name);

  // 2. Curated alias lookup on the cleaned form.
  const alias = ALIASES.get(name.toLowerCase());
  return alias ?? name;
}
