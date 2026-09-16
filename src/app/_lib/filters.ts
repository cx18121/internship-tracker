import type { Internship, AppliedFilter, TierFilter, DateWindow, SortBy } from "./types";
import { isRoleId, type RoleId } from "@/lib/role-taxonomy";
import { applyFilterSpec } from "@/lib/filter-spec";
import { seasonSortKey } from "@/lib/seasons";
import { DATE_WINDOWS } from "./constants";

/** Every user-adjustable list filter. Lives in one object so URL sync,
 *  clearing, counting, and the filter pass all read the same table. */
export interface Filters {
  q: string;
  sources: string[];
  minScore: number;
  locationText: string;
  locations: string[];
  include: string[];
  exclude: string[];
  applied: AppliedFilter;
  tier: TierFilter;
  seasons: string[];
  roles: RoleId[];
  when: DateWindow;
  showHidden: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  q: "",
  sources: [],
  minScore: 0,
  locationText: "",
  locations: [],
  include: [],
  exclude: [],
  applied: "all",
  tier: "all",
  seasons: [],
  roles: [],
  when: "all",
  showHidden: false,
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
  locations: { param: "locs", parse: list, serialize: (v) => v.join(","), counted: true },
  include: { param: "include", parse: list, serialize: (v) => v.join(","), counted: true },
  exclude: { param: "exclude", parse: list, serialize: (v) => v.join(","), counted: true },
  applied: { param: "applied", parse: oneOf(["all", "applied", "not-applied"] as const), serialize: (v) => v, counted: false },
  tier: { param: "tier", parse: oneOf(["all", "solid-or-better", "top-or-better", "elite"] as const), serialize: (v) => v, counted: true },
  seasons: { param: "seasons", parse: list, serialize: (v) => v.join(","), counted: true },
  roles: { param: "roles", parse: (s) => list(s).filter(isRoleId), serialize: (v) => v.join(","), counted: true },
  when: { param: "when", parse: oneOf(DATE_WINDOWS.map((d) => d.value)), serialize: (v) => v, counted: true },
  showHidden: { param: "showHidden", parse: (s) => s === "1", serialize: () => "1", counted: false },
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
  /** Counts over rows passing every filter except the applied tab. */
  tabCounts: { all: number; applied: number; open: number };
  hiddenCount: number;
}

/** One pass over the corpus that produces the list, the season chip counts,
 *  and the applied-tab counts. */
export function evaluateFilters(items: Internship[], f: Filters, sortBy: SortBy, now = Date.now()): FilterResult {
  const q = f.q.trim().toLowerCase();
  const days = DATE_WINDOWS.find((d) => d.value === f.when)?.days ?? null;
  const spec = {
    tier: f.tier,
    excludeHidden: !f.showHidden,
    includeSources: f.sources,
    minScore: f.minScore,
    postedAfter: days == null ? undefined : now - days * 24 * 60 * 60 * 1000,
    includeKeywords: f.include,
    excludeKeywords: f.exclude,
    roles: f.roles,
  };

  const filtered: Internship[] = [];
  const seasonCounts = new Map<string, number>();
  const tabCounts = { all: 0, applied: 0, open: 0 };
  let hiddenCount = 0;

  for (const i of items) {
    if (i.hidden) hiddenCount++;
    if (q && !`${i.company} ${i.title} ${i.location}`.toLowerCase().includes(q)) continue;
    if (!matchesLocation(i.location, f)) continue;
    if (!applyFilterSpec(i, spec)) continue;

    const seasonOk = f.seasons.length === 0 || i.season.some((t) => f.seasons.includes(t));
    const appliedOk = f.applied === "all" || (f.applied === "applied") === i.applied;

    if (appliedOk) for (const t of i.season) seasonCounts.set(t, (seasonCounts.get(t) ?? 0) + 1);
    if (seasonOk) {
      tabCounts.all++;
      if (i.applied) tabCounts.applied++;
    }
    if (seasonOk && appliedOk) filtered.push(i);
  }
  tabCounts.open = tabCounts.all - tabCounts.applied;

  filtered.sort(sortBy === "posted"
    ? (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
    : (a, b) => (b.score ?? -1) - (a.score ?? -1));

  return {
    filtered,
    seasonCounts: [...seasonCounts.entries()].sort(([a], [b]) => seasonSortKey(a).localeCompare(seasonSortKey(b))),
    tabCounts,
    hiddenCount,
  };
}

function matchesLocation(location: string, f: Filters): boolean {
  if (f.locations.length === 0 && !f.locationText) return true;
  const loc = location.toLowerCase();
  if (f.locations.some((l) => loc.includes(l.toLowerCase()))) return true;
  return !!f.locationText && loc.includes(f.locationText.toLowerCase());
}
