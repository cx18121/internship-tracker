"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Briefcase,
  RefreshCw,
  WifiOff,
  Bell,
  ChevronLeft,
  ChevronRight,
  Layers,
  SlidersHorizontal,
  Search,
  X,
} from "lucide-react";

import { InternshipList, groupInternships } from "./_components/InternshipList";
import { NotifModal } from "./_components/NotifModal";
import { StatusPill } from "./_components/StatusPill";
import { FilterRail } from "./_components/FilterRail";
import { MobileFilterSheet } from "./_components/MobileFilterSheet";
import { ListSkeleton, EmptyState } from "./_components/Skeletons";
import { ActiveFilterChips } from "./_components/ActiveFilterChips";
import type { SortBy } from "./_lib/types";
import { PAGE_SIZE, GROUPS_PER_PAGE, DATE_WINDOWS } from "./_lib/constants";
import {
  DEFAULT_FILTERS, activeFilterCount, evaluateFilters, filtersFromParams, writeFiltersToParams, type Filters,
} from "./_lib/filters";
import { useNotifSettings } from "./_hooks/useNotifSettings";
import { useDebouncedValue } from "./_hooks/useDebouncedValue";
import { useIsOwner } from "./_hooks/useIsOwner";
import { useInternshipsData } from "./_hooks/useInternshipsData";

interface View {
  sort: SortBy;
  page: number;
  group: boolean;
}
const DEFAULT_VIEW: View = { sort: "score", page: 1, group: false };

function viewFromParams(sp: URLSearchParams): View {
  const sort = sp.get("sort");
  const page = Number(sp.get("page"));
  return {
    sort: sort === "posted" || sort === "newest" ? "posted" : "score",
    page: Number.isFinite(page) && page > 1 ? page : 1,
    group: sp.get("group") === "1",
  };
}

function writeViewToParams(v: View, params: URLSearchParams): void {
  if (v.sort !== "score") params.set("sort", v.sort);
  if (v.page > 1) params.set("page", String(v.page));
  if (v.group) params.set("group", "1");
}

export default function InternshipsPage() {
  const isOwner = useIsOwner();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  // URL sync and the first fetch wait until state is restored from the URL.
  const [hydrated, setHydrated] = useState(false);

  const { internships, stats, sources, offline, loading, refreshing, refresh } = useInternshipsData(hydrated);
  const notif = useNotifSettings();

  const searchInputRef = useRef<HTMLInputElement>(null);
  // Keystrokes debounce; programmatic sets (URL restore, clear) apply at once.
  const userTypedSearchRef = useRef(false);

  const updateFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setView((v) => (v.page === 1 ? v : { ...v, page: 1 }));
  }, []);
  const updateView = useCallback((patch: Partial<View>) => setView((v) => ({ ...v, ...patch })), []);
  const clearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setView((v) => ({ ...v, sort: "score", page: 1 }));
  }, []);

  // `/` focuses search unless the user is already typing somewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || (t?.isContentEditable ?? false)) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Restore state from the URL on mount.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setFilters(filtersFromParams(sp));
    setView(viewFromParams(sp));
    setHydrated(true);
  }, []);

  const debouncedQ = useDebouncedValue(filters.q, userTypedSearchRef.current && filters.q !== "" ? 120 : 0);
  const effectiveFilters = useMemo(() => ({ ...filters, q: debouncedQ }), [filters, debouncedQ]);

  // Mirror state to the URL.
  useEffect(() => {
    if (!hydrated) return;
    const params = new URLSearchParams();
    writeFiltersToParams(effectiveFilters, params);
    writeViewToParams(view, params);
    const qs = params.toString();
    window.history.replaceState({}, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [hydrated, effectiveFilters, view]);

  const dynamicSources: string[] | null = stats?.bySource
    ? Object.entries(stats.bySource).filter(([, n]) => n > 0).map(([src]) => src).sort()
    : null;

  const { filtered, seasonCounts } = useMemo(
    () => evaluateFilters(internships, effectiveFilters, view.sort),
    [internships, effectiveFilters, view.sort],
  );
  const filterCount = activeFilterCount(effectiveFilters);

  // Grouped list view paginates by company so a company's roles never split.
  const groups = useMemo(() => (view.group ? groupInternships(filtered, view.sort) : null), [view.group, filtered, view.sort]);
  const pageUnitCount = groups ? groups.length : filtered.length;
  const perPage = groups ? GROUPS_PER_PAGE : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(pageUnitCount / perPage));
  const safePage = Math.min(view.page, totalPages);
  const paginated = useMemo(() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filtered, safePage]);
  const pagedGroups = useMemo(() => groups?.slice((safePage - 1) * GROUPS_PER_PAGE, safePage * GROUPS_PER_PAGE) ?? null, [groups, safePage]);

  const railProps = { filters, onChange: updateFilters, onClearAll: clearFilters, sources: dynamicSources, seasonCounts };

  return (
    <div className="min-h-screen">
      {/* Header — single row, ~48px tall. Postings start within the first viewport. */}
      <header className="sticky top-0 z-40 backdrop-blur-sm bg-[oklch(0.13_0.005_260_/_0.85)] border-b border-white/[0.06]">
        <div className="flex items-center justify-between gap-3 px-5 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <Briefcase className="h-4 w-4 text-white/60 shrink-0" />
            <h1 className="text-[13px] font-semibold text-white tracking-tight shrink-0">
              Internships
            </h1>
            <StatusPill
              lastPolledAt={stats?.lastPolledAt ?? null}
              totalPostings={stats?.total ?? null}
              sourcesTotal={sources?.total ?? null}
              exclusionCounts={stats?.exclusionCounts ?? null}
            />
          </div>

          <div className="flex items-center gap-2">
            {/* Mobile filter trigger — desktop has the rail visible */}
            <button
              onClick={() => setMobileFiltersOpen(true)}
              className="lg:hidden inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-[12px] text-white/75 transition-colors"
              aria-label="Open filters"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filters
              {filterCount > 0 && (
                <span className="px-1 py-px rounded text-[10px] bg-white/15 text-white tabular-nums">
                  {filterCount}
                </span>
              )}
            </button>

            <button
                onClick={() => updateView({ group: !view.group, page: 1 })}
                className={`p-1.5 rounded border transition-colors ${
                  view.group
                    ? "border-white/30 bg-white/15 text-white"
                    : "border-white/10 bg-white/[0.04] text-white/40 hover:text-white/70"
                }`}
                title={view.group ? "Ungroup" : "Group by company"}
              >
                <Layers className="h-3.5 w-3.5" />
              </button>
            {isOwner && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setNotifModalOpen(true)}
                aria-label="Notifications"
                className="gap-1.5 h-7 px-2 sm:px-2.5 border-white/10 bg-white/[0.04] hover:bg-white/10 text-[12px]"
              >
                <Bell className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Notifications</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label="Refresh"
              className="gap-1.5 h-7 px-2 sm:px-2.5 border-white/10 bg-white/[0.04] hover:bg-white/10 text-[12px]"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
      </header>

      {offline ? (
        <div className="px-5 py-10 max-w-2xl mx-auto">
          <div className="flex items-center gap-4 p-6 rounded-lg border border-white/10 bg-white/[0.03]">
            <WifiOff className="h-8 w-8 text-white/30 shrink-0" />
            <div>
              <p className="font-medium text-white/70">Agent offline</p>
              <p className="text-sm text-white/40">
                Internship tracker is not running yet. Start it at{" "}
                <code className="text-xs bg-white/10 px-1 rounded">localhost:3001</code>.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 px-5 py-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          {/* Left rail — desktop only; mobile uses MobileFilterSheet (mounted below) */}
          <div className="hidden lg:block lg:sticky lg:top-[3.5rem] lg:self-start lg:max-h-[calc(100vh-4.5rem)] lg:overflow-y-auto lg:pr-2 lg:-mr-2 lg:pb-6">
            <FilterRail {...railProps} />
          </div>

          {/* Main column */}
          <main className="min-w-0 space-y-3">
            {/* Toolbar row 1: search · applied scope · time window · sort · count */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2 border-b border-white/[0.06]">
              {/* Search — primary lookup affordance, focused with `/`. */}
              <div className="relative flex-1 min-w-[180px] max-w-[260px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/35 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={filters.q}
                  onChange={(e) => { userTypedSearchRef.current = true; updateFilters({ q: e.target.value }); }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      updateFilters({ q: "" });
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Search company, title, location…"
                  aria-label="Search postings"
                  className="w-full h-7 pl-7 pr-7 rounded-md bg-white/[0.04] border border-white/10 text-[12px] text-white/85 placeholder:text-white/50 focus:outline-none focus:border-white/25 focus:bg-white/[0.06] transition-colors"
                />
                {filters.q ? (
                  <button
                    type="button"
                    onClick={() => updateFilters({ q: "" })}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded text-white/40 hover:text-white/80 hover:bg-white/[0.06]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : (
                  <kbd className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 px-1 inline-flex items-center justify-center rounded text-[9.5px] font-mono font-medium text-white/40 bg-white/[0.06] border border-white/10">
                    /
                  </kbd>
                )}
              </div>

              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] p-0.5">
                {DATE_WINDOWS.map((w) => (
                  <button
                    key={w.value}
                    onClick={() => updateFilters({ when: w.value })}
                    className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                      filters.when === w.value
                        ? "bg-white/15 text-white"
                        : "text-white/55 hover:text-white/70"
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.08em] text-white/55">Sort</span>
                <Select value={view.sort} onValueChange={(v) => v && updateView({ sort: v as SortBy, page: 1 })}>
                  <SelectTrigger
                    size="sm"
                    className="h-7 border-white/10 bg-white/[0.04] text-white/70 text-[12px] min-w-[7rem]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="score">Score</SelectItem>
                    <SelectItem value="posted">Posted date</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <span className="ml-auto text-[11px] text-white/55 tabular-nums">
                {loading ? "…" : `${filtered.length.toLocaleString()} listing${filtered.length !== 1 ? "s" : ""}`}
                {filterCount > 0 && !loading && (
                  <span className="text-white/55"> · filtered</span>
                )}
              </span>
            </div>

            {/* Active filter chips — visible only when at least one filter is set */}
            <ActiveFilterChips filters={effectiveFilters} onChange={updateFilters} onClearAll={clearFilters} />

            {/* Listings */}
            {loading ? (
              <ListSkeleton />
            ) : filtered.length === 0 ? (
              <EmptyState
                hasActiveFilters={filterCount > 0}
                onClearFilters={clearFilters}
                onClearDateWindow={filters.when !== "all" ? () => updateFilters({ when: "all" }) : null}
                dateWindowLabel={DATE_WINDOWS.find((d) => d.value === filters.when)?.label ?? null}
              />
            ) : (
              <>
                <InternshipList items={paginated} groups={pagedGroups} sortBy={view.sort} />

                {pageUnitCount > 0 && (
                  <div className="sticky bottom-0 z-10 flex items-center justify-center gap-3 pt-4 pb-3 mt-2 bg-gradient-to-t from-[oklch(0.13_0.005_260)] via-[oklch(0.13_0.005_260_/_0.95)] to-transparent">
                    {totalPages > 1 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateView({ page: Math.max(1, safePage - 1) })}
                        disabled={safePage <= 1}
                        className="gap-1.5 h-7 border-white/10 bg-[oklch(0.18_0.005_260)] hover:bg-white/10 disabled:opacity-30 text-[12px]"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                        Prev
                      </Button>
                    )}
                    <span className="text-[12px] text-white/55 tabular-nums whitespace-nowrap">
                      <span className="text-white/85">
                        {((safePage - 1) * perPage + 1).toLocaleString()}
                        {"–"}
                        {Math.min(safePage * perPage, pageUnitCount).toLocaleString()}
                      </span>
                      {" of "}
                      <span className="text-white/85">{pageUnitCount.toLocaleString()}</span>
                      {groups ? " companies" : ""}
                    </span>
                    {totalPages > 1 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateView({ page: Math.min(totalPages, safePage + 1) })}
                        disabled={safePage >= totalPages}
                        className="gap-1.5 h-7 border-white/10 bg-[oklch(0.18_0.005_260)] hover:bg-white/10 disabled:opacity-30 text-[12px]"
                      >
                        Next
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      )}

      <MobileFilterSheet open={mobileFiltersOpen} onClose={() => setMobileFiltersOpen(false)}>
        <FilterRail {...railProps} />
      </MobileFilterSheet>

      <NotifModal
        open={notifModalOpen}
        onOpenChange={setNotifModalOpen}
        settings={notif.settings}
        onChange={notif.update}
        seasonOptions={seasonCounts.map(([token, count]) => ({ token, count }))}
        sources={dynamicSources ?? []}
        onSave={notif.save}
        saving={notif.saving}
        saved={notif.saved}
        error={notif.error}
      />
    </div>
  );
}
