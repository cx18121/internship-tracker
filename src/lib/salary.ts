/**
 * Salary parsing — extracts compensation info from free-text job descriptions.
 *
 * Returns:
 *   text: original matched substring (e.g. "$25-30/hr") — null if nothing found
 *   min, max: numeric bounds in the matched unit (USD, NOT normalized to hourly)
 *   unit: "hourly" | "monthly" | "yearly" — inferred from the match
 *
 * Why we don't normalize to hourly USD here: the conversion ratio is opinionated
 * (yearly/2080? /1920?), and the UI is happier showing the original "$80k/yr"
 * to the user. If we want sorting later, we can normalize at query time.
 */

export interface Salary {
  text: string | null;
  min: number | null;
  max: number | null;
  unit: 'hourly' | 'monthly' | 'yearly' | null;
}

const EMPTY: Salary = { text: null, min: null, max: null, unit: null };

// Patterns are ordered most-specific → least-specific. First match wins.
// Each entry: [regex, unit]. The regex must produce one or two numeric capture
// groups (min, optional max).
const PATTERNS: Array<{ re: RegExp; unit: Salary['unit']; multiplier?: number }> = [
  // Hourly range: $25-30/hr, $25 to $30 per hour, $25.50-$30.00 hourly
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*(?:-|to|–|—|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\/?\s*(?:hr|hour|hourly|\/h\b|per\s+hour)/i, unit: 'hourly' },
  // Hourly single: $25/hr, $25 per hour
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*\/?\s*(?:hr|hour|hourly|\/h\b|per\s+hour)/i, unit: 'hourly' },

  // Monthly range: $5,000-$6,000/month
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*(?:-|to|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\/?\s*(?:mo|month|monthly|per\s+month)/i, unit: 'monthly' },
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*\/?\s*(?:mo|month|monthly|per\s+month)/i, unit: 'monthly' },

  // Yearly range with k suffix: $80k-$120k, $80-120k
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*[kK]\s*(?:-|to|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*[kK]/i, unit: 'yearly', multiplier: 1000 },
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*(?:-|to|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*[kK]\b/i, unit: 'yearly', multiplier: 1000 },

  // Yearly single with k suffix: $80k
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*[kK]\b/i, unit: 'yearly', multiplier: 1000 },

  // Yearly range no k: $50,000-$75,000 (per year / annually)
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*(?:-|to|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\/?\s*(?:yr|year|yearly|annual|annually|per\s+year)/i, unit: 'yearly' },
  // Yearly single no k: $80,000/year, $80,000 annually
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*\/?\s*(?:yr|year|yearly|annual|annually|per\s+year)/i, unit: 'yearly' },

  // Bare $X-$Y when nothing else matches — assume yearly if numbers look big
  // ($10,000+) else hourly. This is the noisiest pattern; only used last.
  { re: /\$\s*([\d,]+(?:\.\d+)?)\s*(?:-|to|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)/, unit: null },
];

function num(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

export function parseSalary(input: string | null | undefined): Salary {
  if (!input) return EMPTY;
  const text = input.replace(/\s+/g, ' ');

  for (const { re, unit, multiplier } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;

    const minRaw = num(m[1]);
    let maxRaw = m[2] !== undefined ? num(m[2]) : minRaw;
    if (!Number.isFinite(minRaw)) continue;
    // Fall back to min if the max capture group parsed to NaN/Infinity, else
    // downstream multiplication propagates NaN past the min>max swap check
    // (NaN comparisons are always false) and a garbage salary lands in storage.
    if (!Number.isFinite(maxRaw)) maxRaw = minRaw;

    const mul = multiplier ?? 1;
    let min = minRaw * mul;
    let max = maxRaw * mul;

    // Sanity: if min > max (shouldn't happen but defensively), swap
    if (min > max) [min, max] = [max, min];

    // Resolve unit for the bare-pattern case
    let resolvedUnit = unit;
    if (!resolvedUnit) {
      resolvedUnit = min >= 10_000 ? 'yearly' : 'hourly';
    }

    // Plausibility filter — drop obvious junk matches like "$5" or "$10,000,000"
    if (resolvedUnit === 'hourly' && (min < 5 || max > 500)) continue;
    if (resolvedUnit === 'monthly' && (min < 500 || max > 50_000)) continue;
    if (resolvedUnit === 'yearly' && (min < 20_000 || max > 1_000_000)) continue;

    return { text: m[0].trim(), min, max, unit: resolvedUnit };
  }

  return EMPTY;
}

/**
 * Normalize a Salary's range to hourly USD (using 2080 working hours/year,
 * 173.33 hours/month). Returns `null` if unparseable.
 *
 * Used for cross-posting comparisons (sort/filter by hourly).
 */
export function toHourly(s: Salary): { min: number; max: number } | null {
  if (s.min === null || s.max === null || s.unit === null) return null;
  const div = s.unit === 'hourly' ? 1 : s.unit === 'monthly' ? 173.33 : 2080;
  return { min: s.min / div, max: s.max / div };
}
