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
  LayoutGrid,
  List,
  Layers,
  SlidersHorizontal,
  Search,
  X,
  Eye,
} from "lucide-react";

import { InternshipCard } from "./_components/InternshipCard";
import { InternshipList, groupInternships } from "./_components/InternshipList";
import { NotifModal } from "./_components/NotifModal";
import { StatusPill } from "./_components/StatusPill";
import { FilterRail } from "./_components/FilterRail";
import { MobileFilterSheet } from "./_components/MobileFilterSheet";
import { ListSkeleton, CardSkeleton, EmptyState } from "./_components/Skeletons";
import { ActiveFilterChips } from "./_components/ActiveFilterChips";
import type { AppliedFilter, SortBy } from "./_lib/types";
import { PAGE_SIZE, GROUPS_PER_PAGE, DATE_WINDOWS } from "./_lib/constants";
import { lsGet, lsSet, LS_NOTES_KEY } from "./_lib/storage";
import { ROLE_SPECIALIZATIONS, postingMatchesRole, type RoleId } from "@/lib/role-taxonomy";
import {
  DEFAULT_FILTERS, activeFilterCount, evaluateFilters, filtersFromParams, writeFiltersToParams, type Filters,
} from "./_lib/filters";
import { useOptimisticPatch } from "./_hooks/useOptimisticPatch";
import { useNotifSettings } from "./_hooks/useNotifSettings";
import { useDebouncedValue } from "./_hooks/useDebouncedValue";
import { useIsOwner } from "./_hooks/useIsOwner";
import { useInternshipsData } from "./_hooks/useInternshipsData";

interface View {
  sort: SortBy;
  page: number;
  mode: "card" | "list";
  group: boolean;
}
const DEFAULT_VIEW: View = { sort: "score", page: 1, mode: "list", group: false };

function viewFromParams(sp: URLSearchParams): View {
  const sort = sp.get("sort");
  const page = Number(sp.get("page"));
  const mode = sp.get("view");
  return {
    sort: sort === "posted" || sort === "newest" ? "posted" : "score",
    page: Number.isFinite(page) && page > 1 ? page : 1,
    mode: mode === "card" ? "card" : "list",
    group: sp.get("group") === "1",
  };
}

function writeViewToParams(v: View, params: URLSearchParams): void {
  if (v.sort !== "score") params.set("sort", v.sort);
  if (v.page > 1) params.set("page", String(v.page));
  if (v.mode !== "list") params.set("view", v.mode);
  if (v.mode === "list" && v.group) params.set("group", "1");
}

export default function InternshipsPage() {
  const isOwner = useIsOwner();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  // URL sync and the first fetch wait until state is restored from the URL.
  const [hydrated, setHydrated] = useState(false);

  const data = useInternshipsData(isOwner, hydrated);
  const { internships, setInternships, stats, sources, offline, loading, refreshing, refresh } = data;
  const { pendingIds, patch } = useOptimisticPatch();
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

  // Restore state from URL and localStorage on mount.
  useEffect(() => {
    setNotesMap(lsGet<Record<string, string>>(LS_NOTES_KEY, {}));
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

  const patchField = useCallback((id: string, next: { applied?: boolean; hidden?: boolean }, current: typeof next) => {
    const appliedAt = next.applied === undefined ? {} : { appliedAt: next.applied ? new Date().toISOString() : null };
    return patch(
      id,
      { ...next, ...appliedAt },
      () => setInternships((prev) => prev.map((i) => (i.id === id ? { ...i, ...next, ...(appliedAt.appliedAt !== undefined ? { appliedAt: appliedAt.appliedAt ?? undefined } : {}) } : i))),
      () => setInternships((prev) => prev.map((i) => (i.id === id ? { ...i, ...current } : i))),
    );
  }, [patch, setInternships]);

  const toggleApplied = useCallback((id: string, current: boolean) => {
    void patchField(id, { applied: !current }, { applied: current });
  }, [patchField]);
  const handleHide = useCallback((id: string, hidden: boolean) => {
    void patchField(id, { hidden: !hidden }, { hidden });
  }, [patchField]);

  const updateNote = useCallback((id: string, note: string) => {
    setNotesMap((prev) => {
      const next = { ...prev, [id]: note };
      if (!note) delete next[id];
      lsSet(LS_NOTES_KEY, next);
      return next;
    });
  }, []);

  const dynamicSources: string[] | null = stats?.bySource
    ? Object.entries(stats.bySource).filter(([, n]) => n > 0).map(([src]) => src).sort()
    : null;

  // Keyword and role chips outside these sets are dimmed: they would match nothing.
  const knownKeywords = useMemo(() => {
    const set = new Set<string>();
    for (const i of internships) for (const k of i.matchedKeywords) set.add(k.toLowerCase());
    return set;
  }, [internships]);
  const availableRoles = useMemo(() => {
    const set = new Set<RoleId>();
    for (const role of ROLE_SPECIALIZATIONS) {
      if (internships.some((i) => postingMatchesRole(i.matchedKeywords, role.id))) set.add(role.id);
    }
    return set;
  }, [internships]);

  const { filtered, seasonCounts, tabCounts, hiddenCount } = useMemo(
    () => evaluateFilters(internships, effectiveFilters, view.sort),
    [internships, effectiveFilters, view.sort],
  );
  const filterCount = activeFilterCount(effectiveFilters);

  // Grouped list view paginates by company so a company's roles never split.
  const isGroupedList = view.mode === "list" && view.group;
  const groups = useMemo(() => (isGroupedList ? groupInternships(filtered, view.sort) : null), [isGroupedList, filtered, view.sort]);
  const pageUnitCount = groups ? groups.length : filtered.length;
  const perPage = groups ? GROUPS_PER_PAGE : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(pageUnitCount / perPage));
  const safePage = Math.min(view.page, totalPages);
  const paginated = useMemo(() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filtered, safePage]);
  const pagedGroups = useMemo(() => groups?.slice((safePage - 1) * GROUPS_PER_PAGE, safePage * GROUPS_PER_PAGE) ?? null, [groups, safePage]);

  const railProps = {
    filters, onChange: updateFilters, onClearAll: clearFilters,
    sources: dynamicSources, seasonCounts, knownKeywords, availableRoles,
  };

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

            <div className="flex items-center rounded-md border border-white/10 bg-white/[0.04] p-0.5">
              <button
                onClick={() => updateView({ mode: "list" })}
                className={`p-1.5 rounded transition-colors ${
                  view.mode === "list" ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"
                }`}
                title="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => updateView({ mode: "card" })}
                className={`p-1.5 rounded transition-colors ${
                  view.mode === "card" ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"
                }`}
                title="Card view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </div>
            {view.mode === "list" && (
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
            )}
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
                {(["all", "not-applied", "applied"] as AppliedFilter[]).map((tab) => {
                  const count =
                    tab === "all" ? tabCounts.all : tab === "applied" ? tabCounts.applied : tabCounts.open;
                  const active = filters.applied === tab;
                  return (
                    <button
                      key={tab}
                      onClick={() => updateFilters({ applied: tab })}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors ${
                        active
                          ? "bg-white/15 text-white"
                          : "text-white/55 hover:text-white/70"
                      }`}
                    >
                      <span>{tab === "not-applied" ? "Open" : tab === "applied" ? "Applied" : "All"}</span>
                      <span
                        className={`tabular-nums text-[10px] ${
                          active ? "text-white/65" : "text-white/55"
                        }`}
                      >
                        {count.toLocaleString()}
                      </span>
                    </button>
                  );
                })}
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
                {hiddenCount > 0 && !loading && (
                  <>
                    <span className="text-white/45"> · </span>
                    <button
                      onClick={() => updateFilters({ showHidden: !filters.showHidden })}
                      className="inline-flex items-center gap-1 text-white/55 hover:text-white/85 transition-colors normal-nums underline-offset-4 hover:underline"
                      title={filters.showHidden ? "Hide hidden postings" : "Show hidden postings"}
                    >
                      <Eye className="h-3 w-3" />
                      {hiddenCount} hidden
                      {filters.showHidden && <span className="text-emerald-300/80"> · shown</span>}
                    </button>
                  </>
                )}
              </span>
            </div>

            {/* Active filter chips — visible only when at least one filter is set */}
            <ActiveFilterChips filters={effectiveFilters} onChange={updateFilters} onClearAll={clearFilters} />

            {/* Listings */}
            {loading ? (
              view.mode === "list" ? (
                <ListSkeleton />
              ) : (
                <CardSkeleton />
              )
            ) : filtered.length === 0 ? (
              <EmptyState
                hasActiveFilters={filterCount > 0}
                onClearFilters={clearFilters}
                onClearDateWindow={filters.when !== "all" ? () => updateFilters({ when: "all" }) : null}
                dateWindowLabel={DATE_WINDOWS.find((d) => d.value === filters.when)?.label ?? null}
              />
            ) : (
              <>
                {view.mode === "list" ? (
                  <InternshipList
                    items={paginated}
                    groups={pagedGroups}
                    sortBy={view.sort}
                    pendingIds={pendingIds}
                    onToggleApplied={toggleApplied}
                    onHide={handleHide}
                    isOwner={isOwner}
                  />
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
                    {paginated.map((item) => (
                      <InternshipCard
                        key={item.id}
                        item={item}
                        notes={notesMap[item.id] ?? ""}
                        pending={pendingIds.has(item.id)}
                        onNotesChange={updateNote}
                        onToggleApplied={toggleApplied}
                        onHide={handleHide}
                        isOwner={isOwner}
                      />
                    ))}
                  </div>
                )}

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
                      {isGroupedList ? " companies" : ""}
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
        knownKeywords={knownKeywords}
        availableRoles={availableRoles}
        onSave={notif.save}
        saving={notif.saving}
        saved={notif.saved}
        error={notif.error}
      />
    </div>
  );
}
