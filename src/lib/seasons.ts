/**
 * Pure season parser shared between the UI filter and the server-side
 * notifier. Returns one or more `${season}-${year}` tokens extracted from a
 * job title (e.g. "summer-2026"). If a year is present but no season,
 * returns a `year-${year}` fallback so the user can still filter by year.
 */

export type SeasonName = 'summer' | 'fall' | 'winter' | 'spring';

const SEASON_RE = /\b(summer|fall|autumn|winter|spring)\b[ ,/\-_–—'']{0,3}(20\d{2}|'?\d{2})\b|\b(20\d{2})\b[ ,/\-_–—'']{0,3}(summer|fall|autumn|winter|spring)\b/g;
const BARE_YEAR_RE = /\b(202\d)\b/;

function normalizeSeason(s: string): SeasonName {
  // Autumn collapses to fall — same season, different naming convention.
  return s === 'autumn' ? 'fall' : (s as SeasonName);
}

function normalizeYear(s: string): string | null {
  const stripped = s.replace(/^'/, '');
  if (stripped.length === 4) return stripped;
  if (stripped.length === 2) return `20${stripped}`;
  return null;
}

export function parseSeason(title: string | null | undefined): string[] {
  if (!title) return [];
  const text = title.toLowerCase();
  const out = new Set<string>();

  for (const m of text.matchAll(SEASON_RE)) {
    const seasonRaw = m[1] ?? m[4];
    const yearRaw = m[2] ?? m[3];
    if (!seasonRaw || !yearRaw) continue;
    const year = normalizeYear(yearRaw);
    if (!year) continue;
    out.add(`${normalizeSeason(seasonRaw)}-${year}`);
  }

  if (out.size === 0) {
    const m = text.match(BARE_YEAR_RE);
    if (m) out.add(`year-${m[1]}`);
  }

  return Array.from(out).sort();
}

/** Pretty-print a parsed token for display in the UI. */
export function formatSeasonLabel(token: string): string {
  const [first, year] = token.split('-');
  if (first === 'year') return year;
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} ${year}`;
}

/** Sort key so chips render as: Winter < Spring < Summer < Fall, year ASC. */
const SEASON_ORDER: Record<string, number> = { winter: 0, spring: 1, summer: 2, fall: 3, year: 4 };
export function seasonSortKey(token: string): string {
  const [first, year] = token.split('-');
  const ord = SEASON_ORDER[first] ?? 9;
  return `${year}-${ord}`;
}

/**
 * The "fallback" season for a posting whose title carries no season info.
 * Internship cycles flip mid-year: postings discovered Jan–Jun belong to
 * that year's summer cycle; postings discovered Jul–Dec belong to the
 * following year's summer cycle.
 */
export function defaultSeasonForDate(d: Date = new Date()): string {
  const year = d.getUTCMonth() >= 6 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  return `summer-${year}`;
}

/**
 * Resolves a posting's season tokens with the same semantics the one-time
 * backfill applied: parseSeason result wins, bare year-YYYY tokens are
 * promoted to summer-YYYY, and an empty parse falls back to the current
 * default intern cycle. Used by both new-row ingestion (toRow) and the
 * legacy backfill script so both paths stay in sync.
 */
export function deriveSeasonWithDefault(title: string | null | undefined): string[] {
  const parsed = parseSeason(title);
  if (parsed.length === 0) return [defaultSeasonForDate()];
  const out: string[] = [];
  for (const t of parsed) {
    out.push(t.startsWith('year-') ? `summer-${t.slice(5)}` : t);
  }
  return Array.from(new Set(out));
}
