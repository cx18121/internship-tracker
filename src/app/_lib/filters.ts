import type { Internship, DateWindow, SortBy } from "./types";
import { COMPANY_TIERS, type CompanyTier } from "@/lib/classify/company";
import { ROLE_TYPES, DEGREES, type RoleType, type Degree } from "@/lib/classify/posting";
import { METROS, type Metro } from "@/lib/metros";
import { applyFilterSpec, listedAt } from "@/lib/filter-spec";
import { seasonSortKey } from "@/lib/seasons";
import { DATE_WINDOWS } from "./constants";

/** Every user-adjustable list filter. Lives in one object so URL sync,
 *  clearing, counting, and the filter pass all read the same table. */
export interface Filters {
  q: string;
  sources: string[];
  minScore: number;
  locationText: string;
  metros: Metro[];
  tiers: CompanyTier[];
  seasons: string[];
  roleTypes: RoleType[];
  degrees: Array<Degree | "unknown">;
  when: DateWindow;
}

export const DEFAULT_FILTERS: Filters = {
  q: "",
  sources: [],
  minScore: 0,
  locationText: "",
  metros: [],
  tiers: [],
  seasons: [],
  roleTypes: [],
  degrees: [],
  when: "all",
};

interface Codec<K extends keyof Filters> {
  param: string;
  parse: (raw: string) => Filters[K] | undefined;
  serialize: (v: Filters[K]) => string;
  /** Whether a non-default value counts toward the "N filters" badge. */
  counted: boolean;
}

const list = (raw: string) => raw.split(",").map((s) => s.trim()).filter(Boolean);
const oneOf = <T extends string>(values: readonly T[]) => (raw: string) => (values as readonly string[]).includes(raw) ? (raw as T) : undefined;

const CODECS: { [K in keyof Filters]: Codec<K> } = {
  q: { param: "q", parse: (s) => s, serialize: (v) => v, counted: true },
  sources: { param: "sources", parse: list, serialize: (v) => v.join(","), counted: true },
  minScore: { param: "minScore", parse: (s) => (Number.isFinite(+s) && +s > 0 ? +s : undefined), serialize: String, counted: true },
  locationText: { param: "location", parse: (s) => s, serialize: (v) => v, counted: true },
  metros: { param: "metro", parse: (s) => list(s).filter((x): x is Metro => (METROS as readonly string[]).includes(x)), serialize: (v) => v.join(","), counted: true },
  tiers: { param: "tier", parse: (s) => list(s).filter((x): x is CompanyTier => (COMPANY_TIERS as readonly string[]).includes(x)), serialize: (v) => v.join(","), counted: true },
  seasons: { param: "seasons", parse: list, serialize: (v) => v.join(","), counted: true },
  roleTypes: { param: "type", parse: (s) => list(s).filter((x): x is RoleType => (ROLE_TYPES as readonly string[]).includes(x)), serialize: (v) => v.join(","), counted: true },
  degrees: { param: "degree", parse: (s) => list(s).filter((x): x is Degree | "unknown" => x === "unknown" || (DEGREES as readonly string[]).includes(x)), serialize: (v) => v.join(","), counted: true },
  when: { param: "when", parse: oneOf(DATE_WINDOWS.map((d) => d.value)), serialize: (v) => v, counted: true },
};

const KEYS = Object.keys(CODECS) as Array<keyof Filters>;

function isDefault<K extends keyof Filters>(key: K, v: Filters[K]): boolean {
  const d = DEFAULT_FILTERS[key];
  return Array.isArray(v) ? v.length === 0 : v === d;
}

export function filtersFromParams(sp: URLSearchParams): Filters {
  const f = { ...DEFAULT_FILTERS };
  for (const key of KEYS) {
    const raw = sp.get(CODECS[key].param);
    if (raw === null) continue;
    const v = CODECS[key].parse(raw);
    if (v !== undefined && !isDefault(key, v as Filters[typeof key])) (f as Record<string, unknown>)[key] = v;
  }
  return f;
}

export function writeFiltersToParams(f: Filters, params: URLSearchParams): void {
  for (const key of KEYS) {
    const v = f[key];
    if (!isDefault(key, v)) params.set(CODECS[key].param, (CODECS[key].serialize as (x: unknown) => string)(v));
  }
}

export function activeFilterCount(f: Filters): number {
  return KEYS.filter((k) => CODECS[k].counted && !isDefault(k, f[k])).length;
}

export interface FilterResult {
  /** Rows that pass every filter, sorted. */
  filtered: Internship[];
  /** Season token → count over rows passing every filter except season. */
  seasonCounts: Array<[string, number]>;
  /** Metro → count over rows passing every filter except metro. */
  metroCounts: Partial<Record<Metro, number>>;
}

/** One pass over the corpus that produces the list and the season chip counts. */
export function evaluateFilters(items: Internship[], f: Filters, sortBy: SortBy, now = Date.now()): FilterResult {
  const q = f.q.trim().toLowerCase();
  const days = DATE_WINDOWS.find((d) => d.value === f.when)?.days ?? null;
  const spec = {
    tiers: f.tiers,
    includeSources: f.sources,
    minScore: f.minScore,
    postedAfter: days == null ? undefined : now - days * 24 * 60 * 60 * 1000,
    roleTypes: f.roleTypes,
    degrees: f.degrees,
  };

  const filtered: Internship[] = [];
  const seasonCounts = new Map<string, number>();
  const metroCounts: Partial<Record<Metro, number>> = {};

  for (const i of items) {
    const locs = i.locations ?? [i.location];
    if (q && !`${i.company} ${i.title} ${locs.join(' ')}`.toLowerCase().includes(q)) continue;
    if (f.locationText && !locs.some((l) => l.toLowerCase().includes(f.locationText.toLowerCase()))) continue;
    if (!applyFilterSpec(i, spec)) continue;
    const seasonOk = f.seasons.length === 0 || i.season.some((t) => f.seasons.includes(t));
    const metroOk = f.metros.length === 0 || (i.metros ?? []).some((m) => f.metros.includes(m));
    if (metroOk) for (const t of i.season) seasonCounts.set(t, (seasonCounts.get(t) ?? 0) + 1);
    if (seasonOk) for (const m of i.metros ?? []) metroCounts[m] = (metroCounts[m] ?? 0) + 1;
    if (seasonOk && metroOk) filtered.push(i);
  }

  filtered.sort(sortBy === "posted"
    ? (a, b) => new Date(listedAt(b)).getTime() - new Date(listedAt(a)).getTime()
    : (a, b) => (b.score ?? -1) - (a.score ?? -1));

  return {
    filtered,
    seasonCounts: [...seasonCounts.entries()].sort(([a], [b]) => seasonSortKey(a).localeCompare(seasonSortKey(b))),
    metroCounts,
  };
}
