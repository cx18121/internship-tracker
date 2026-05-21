"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
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
} from "lucide-react";

import { InternshipCard } from "./_components/InternshipCard";
import { InternshipList } from "./_components/InternshipList";
import { NotifModal } from "./_components/NotifModal";
import { StatusPill } from "./_components/StatusPill";
import { FilterRail } from "./_components/FilterRail";
import { MobileFilterSheet } from "./_components/MobileFilterSheet";
import { ListSkeleton, CardSkeleton, EmptyState } from "./_components/Skeletons";
import type {
  Internship,
  Stats,
  Sources,
  AppliedFilter,
  SortBy,
  TierFilter,
  DateWindow,
} from "./_lib/types";
import { PAGE_SIZE, DATE_WINDOWS } from "./_lib/constants";
import { lsGet, lsSet, LS_DATES_KEY, LS_NOTES_KEY } from "./_lib/storage";
import { isElite, isTopOrBetter } from "@/lib/tiers";
import { parseSeason, seasonSortKey } from "@/lib/seasons";

export default function InternshipsPage() {
  const [internships, setInternships] = useState<Internship[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters — kept in flat state so URL round-trips stay simple.
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [locationText, setLocationText] = useState("");
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [includeKeywords, setIncludeKeywords] = useState<string[]>([]);
  const [excludeKeywords, setExcludeKeywords] = useState<string[]>([]);
  const [appliedFilter, setAppliedFilter] = useState<AppliedFilter>("all");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [selectedSeasons, setSelectedSeasons] = useState<string[]>([]);
  const [dateWindow, setDateWindow] = useState<DateWindow>("all");

  // Sort & pagination
  const [sortBy, setSortBy] = useState<SortBy>("score");
  const [currentPage, setCurrentPage] = useState(1);
  const [viewMode, setViewMode] = useState<"card" | "list">("list");
  const [groupByCompany, setGroupByCompany] = useState(false);

  // Applied tracking (localStorage)
  const [appliedDates, setAppliedDates] = useState<Record<string, string>>({});
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});

  // Mobile-only filter sheet (rail is hidden below `lg`)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // Notification settings
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  const [notifMinScore, setNotifMinScore] = useState(50);
  const [sourceDownAlerts, setSourceDownAlerts] = useState(false);
  const [notifTierFilter, setNotifTierFilter] = useState<TierFilter>("all");
  const [notifSeasons, setNotifSeasons] = useState<string[]>([]);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifSaved, setNotifSaved] = useState(false);

  // Hydration guard — URL sync waits until initial state is loaded
  const [hydrated, setHydrated] = useState(false);

  // Load localStorage + initial filter state from URL on mount
  useEffect(() => {
    setAppliedDates(lsGet<Record<string, string>>(LS_DATES_KEY, {}));
    setNotesMap(lsGet<Record<string, string>>(LS_NOTES_KEY, {}));

    const sp = new URLSearchParams(window.location.search);
    const parseList = (key: string) =>
      (sp.get(key) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

    const sources = parseList("sources");
    if (sources.length) setSelectedSources(sources);

    const locs = parseList("locs");
    if (locs.length) setSelectedLocations(locs);

    const inc = parseList("include");
    if (inc.length) setIncludeKeywords(inc);

    const exc = parseList("exclude");
    if (exc.length) setExcludeKeywords(exc);

    const ms = Number(sp.get("minScore"));
    if (Number.isFinite(ms) && ms > 0) setMinScore(ms);

    const loc = sp.get("location");
    if (loc) setLocationText(loc);

    const applied = sp.get("applied") as AppliedFilter | null;
    if (applied === "applied" || applied === "not-applied") setAppliedFilter(applied);

    const tier = sp.get("tier") as TierFilter | null;
    if (tier === "top-or-better" || tier === "elite") setTierFilter(tier);

    const seasons = parseList("seasons");
    if (seasons.length) setSelectedSeasons(seasons);

    const window_ = sp.get("when") as DateWindow | null;
    if (window_ && DATE_WINDOWS.some((d) => d.value === window_)) setDateWindow(window_);

    const view = sp.get("view");
    if (view === "list" || view === "card") setViewMode(view);

    if (sp.get("group") === "1") setGroupByCompany(true);

    const sort = sp.get("sort");
    // Legacy URL with ?sort=newest still routes to a usable answer.
    if (sort === "newest" || sort === "posted") setSortBy("posted");
    else if (sort === "score") setSortBy("score");

    const page = Number(sp.get("page"));
    if (Number.isFinite(page) && page > 1) setCurrentPage(page);

    setHydrated(true);
  }, []);

  // Push filter state back to URL whenever it changes (after hydration)
  useEffect(() => {
    if (!hydrated) return;
    const params = new URLSearchParams();
    if (selectedSources.length) params.set("sources", selectedSources.join(","));
    if (selectedLocations.length) params.set("locs", selectedLocations.join(","));
    if (includeKeywords.length) params.set("include", includeKeywords.join(","));
    if (excludeKeywords.length) params.set("exclude", excludeKeywords.join(","));
    if (minScore > 0) params.set("minScore", String(minScore));
    if (locationText) params.set("location", locationText);
    if (appliedFilter !== "all") params.set("applied", appliedFilter);
    if (tierFilter !== "all") params.set("tier", tierFilter);
    if (selectedSeasons.length) params.set("seasons", selectedSeasons.join(","));
    if (dateWindow !== "all") params.set("when", dateWindow);
    if (viewMode !== "list") params.set("view", viewMode);
    if (viewMode === "list" && groupByCompany) params.set("group", "1");
    if (sortBy !== "score") params.set("sort", sortBy);
    if (currentPage > 1) params.set("page", String(currentPage));

    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState({}, "", url);
  }, [
    hydrated,
    selectedSources, selectedLocations, includeKeywords, excludeKeywords,
    minScore, locationText, appliedFilter, tierFilter, selectedSeasons, dateWindow,
    viewMode, groupByCompany, sortBy, currentPage,
  ]);

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedSources.length === 1) params.set("source", selectedSources[0]);
      if (minScore > 0) params.set("minScore", String(minScore));

      const [listRes, statsRes, sourcesRes] = await Promise.all([
        fetch(`/api/internships?${params.toString()}`),
        fetch("/api/internships/stats"),
        fetch("/api/internships/sources"),
      ]);

      if (listRes.status === 503 || statsRes.status === 503) {
        setOffline(true);
        return;
      }
      setOffline(false);

      if (listRes.ok) setInternships(await listRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
      if (sourcesRes.ok) setSources(await sourcesRes.json());
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedSources, minScore]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Reset to page 1 when filters or sort change. Skip during initial hydration
  // so a shared URL like ?page=3&sources=Indeed lands on page 3, not page 1.
  useEffect(() => {
    if (!hydrated) return;
    setCurrentPage(1);
  }, [
    hydrated,
    selectedSources, minScore, selectedLocations, locationText,
    includeKeywords, excludeKeywords, appliedFilter, tierFilter,
    selectedSeasons, dateWindow, sortBy,
  ]);

  // Load notification settings
  useEffect(() => {
    fetch("/api/internships/settings")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d) {
          setNotifMinScore(d.minScore ?? 50);
          setSourceDownAlerts(d.sourceDownAlerts ?? false);
          if (d.tierFilter === "elite" || d.tierFilter === "top-or-better" || d.tierFilter === "all") {
            setNotifTierFilter(d.tierFilter);
          }
          if (Array.isArray(d.seasons)) setNotifSeasons(d.seasons);
        }
      })
      .catch(() => {});
  }, []);

  async function toggleApplied(id: string, current: boolean) {
    setInternships((prev) => prev.map((i) => (i.id === id ? { ...i, applied: !current } : i)));
    const newDates = { ...appliedDates };
    if (!current) newDates[id] = new Date().toISOString();
    else delete newDates[id];
    setAppliedDates(newDates);
    lsSet(LS_DATES_KEY, newDates);

    try {
      await fetch(`/api/internships/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applied: !current }),
      });
    } catch {
      // revert
      setInternships((prev) => prev.map((i) => (i.id === id ? { ...i, applied: current } : i)));
      const reverted = { ...appliedDates };
      if (current) reverted[id] = new Date().toISOString();
      else delete reverted[id];
      setAppliedDates(reverted);
      lsSet(LS_DATES_KEY, reverted);
    }
  }

  function updateNote(id: string, note: string) {
    const updated = { ...notesMap, [id]: note };
    if (!note) delete updated[id];
    setNotesMap(updated);
    lsSet(LS_NOTES_KEY, updated);
  }

  async function saveNotifSettings() {
    setNotifSaving(true);
    try {
      await fetch("/api/internships/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minScore: notifMinScore,
          sourceDownAlerts,
          tierFilter: notifTierFilter,
          seasons: notifSeasons,
        }),
      });
      setNotifSaved(true);
      setTimeout(() => setNotifSaved(false), 2000);
    } catch {}
    setNotifSaving(false);
  }

  function clearFilters() {
    setSelectedSources([]);
    setMinScore(0);
    setLocationText("");
    setSelectedLocations([]);
    setIncludeKeywords([]);
    setExcludeKeywords([]);
    setAppliedFilter("all");
    setTierFilter("all");
    setSelectedSeasons([]);
    setDateWindow("all");
    setSortBy("score");
    setCurrentPage(1);
  }

  function toggleArr<T>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
  }

  // Dynamic sources from stats
  const dynamicSources: string[] | null = stats?.bySource
    ? Object.entries(stats.bySource)
        .filter(([, count]) => count > 0)
        .map(([src]) => src)
        .sort()
    : null;

  // Dynamic season tokens. Prefer the stored `season` field; fall back to
  // parseSeason for any pre-migration row that's still null. Chronological
  // sort (winter → spring → summer → fall, year ASC).
  const dynamicSeasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of internships) {
      const tokens = i.season ?? parseSeason(i.title);
      for (const s of tokens) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) =>
      seasonSortKey(a).localeCompare(seasonSortKey(b)),
    );
  }, [internships]);

  // Date-window cutoff in ms. `null` means no date filter (all time).
  const windowCutoff = useMemo(() => {
    const cfg = DATE_WINDOWS.find((d) => d.value === dateWindow);
    if (!cfg || cfg.days == null) return null;
    return Date.now() - cfg.days * 24 * 60 * 60 * 1000;
  }, [dateWindow]);

  // Client-side filter + sort
  const filtered = internships
    .filter((i) => {
      if (selectedSources.length > 0 && !selectedSources.includes(i.source)) return false;
      if (minScore > 0 && (i.score ?? 0) < minScore) return false;
      if (appliedFilter === "applied" && !i.applied) return false;
      if (appliedFilter === "not-applied" && i.applied) return false;
      if (tierFilter === "elite" && !isElite(i.company)) return false;
      if (tierFilter === "top-or-better" && !isTopOrBetter(i.company)) return false;
      if (selectedSeasons.length > 0) {
        const tokens = i.season ?? parseSeason(i.title);
        if (!tokens.some((t) => selectedSeasons.includes(t))) return false;
      }
      if (windowCutoff !== null) {
        const seen = new Date(i.seenAt ?? 0).getTime();
        if (!Number.isFinite(seen) || seen < windowCutoff) return false;
      }
      if (selectedLocations.length > 0 || locationText) {
        const loc = i.location.toLowerCase();
        const locMatch = selectedLocations.some((l) => loc.includes(l.toLowerCase()));
        const textMatch = locationText ? loc.includes(locationText.toLowerCase()) : false;
        if (!locMatch && !textMatch && !(selectedLocations.length === 0)) return false;
        if (selectedLocations.length === 0 && locationText && !textMatch) return false;
      }
      if (includeKeywords.length > 0) {
        const kws = (i.matchedKeywords ?? []).map((k) => k.toLowerCase());
        if (!includeKeywords.some((k) => kws.includes(k.toLowerCase()))) return false;
      }
      if (excludeKeywords.length > 0) {
        const kws = (i.matchedKeywords ?? []).map((k) => k.toLowerCase());
        if (excludeKeywords.some((k) => kws.includes(k.toLowerCase()))) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "posted") {
        return new Date(b.postedAt ?? 0).getTime() - new Date(a.postedAt ?? 0).getTime();
      }
      return (b.score ?? -1) - (a.score ?? -1);
    });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const activeFilterCount =
    (selectedSources.length > 0 ? 1 : 0) +
    (minScore > 0 ? 1 : 0) +
    (selectedLocations.length > 0 ? 1 : 0) +
    (locationText !== "" ? 1 : 0) +
    (includeKeywords.length > 0 ? 1 : 0) +
    (excludeKeywords.length > 0 ? 1 : 0) +
    (tierFilter !== "all" ? 1 : 0) +
    (selectedSeasons.length > 0 ? 1 : 0);

  return (
    <div className="min-h-screen">
      {/* Header — single row, ~48px tall. Postings start within the first viewport. */}
      <header className="sticky top-0 z-40 backdrop-blur-sm bg-[oklch(0.13_0.005_260_/_0.85)] border-b border-white/[0.06]">
        <div className="flex items-center justify-between gap-3 px-5 py-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <Briefcase className="h-4 w-4 text-white/60 shrink-0" />
            <h1 className="text-[13px] font-semibold text-white tracking-tight truncate">
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
              {activeFilterCount > 0 && (
                <span className="px-1 py-px rounded text-[10px] bg-white/15 text-white tabular-nums">
                  {activeFilterCount}
                </span>
              )}
            </button>

            <div className="flex items-center rounded-md border border-white/10 bg-white/[0.04] p-0.5">
              <button
                onClick={() => setViewMode("list")}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === "list" ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"
                }`}
                title="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setViewMode("card")}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === "card" ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"
                }`}
                title="Card view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </div>
            {viewMode === "list" && (
              <button
                onClick={() => setGroupByCompany((v) => !v)}
                className={`p-1.5 rounded border transition-colors ${
                  groupByCompany
                    ? "border-white/30 bg-white/15 text-white"
                    : "border-white/10 bg-white/[0.04] text-white/40 hover:text-white/70"
                }`}
                title={groupByCompany ? "Ungroup" : "Group by company"}
              >
                <Layers className="h-3.5 w-3.5" />
              </button>
            )}
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchData(true)}
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
            <FilterRail
              dynamicSources={dynamicSources}
              dynamicSeasons={dynamicSeasons}
              selectedSources={selectedSources}
              tierFilter={tierFilter}
              selectedSeasons={selectedSeasons}
              minScore={minScore}
              selectedLocations={selectedLocations}
              locationText={locationText}
              includeKeywords={includeKeywords}
              excludeKeywords={excludeKeywords}
              setSelectedSources={setSelectedSources}
              setTierFilter={setTierFilter}
              setSelectedSeasons={setSelectedSeasons}
              setMinScore={setMinScore}
              setSelectedLocations={setSelectedLocations}
              setLocationText={setLocationText}
              setIncludeKeywords={setIncludeKeywords}
              setExcludeKeywords={setExcludeKeywords}
              activeFilterCount={activeFilterCount}
              onClearAll={clearFilters}
            />
          </div>

          {/* Main column */}
          <main className="min-w-0 space-y-3">
            {/* Toolbar: applied scope · time window · sort · count */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2 border-b border-white/[0.06]">
              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] p-0.5">
                {(["all", "not-applied", "applied"] as AppliedFilter[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setAppliedFilter(tab)}
                    className={`px-2.5 py-1 rounded text-[11px] transition-colors capitalize ${
                      appliedFilter === tab
                        ? "bg-white/15 text-white"
                        : "text-white/45 hover:text-white/70"
                    }`}
                  >
                    {tab === "not-applied" ? "Open" : tab === "applied" ? "Applied" : "All"}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] p-0.5">
                {DATE_WINDOWS.map((w) => (
                  <button
                    key={w.value}
                    onClick={() => setDateWindow(w.value)}
                    className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                      dateWindow === w.value
                        ? "bg-white/15 text-white"
                        : "text-white/45 hover:text-white/70"
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.08em] text-white/40">Sort</span>
                <Select value={sortBy} onValueChange={(v) => v && setSortBy(v as SortBy)}>
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

              <span className="ml-auto text-[11px] text-white/45 tabular-nums">
                {loading ? "…" : `${filtered.length.toLocaleString()} listing${filtered.length !== 1 ? "s" : ""}`}
                {activeFilterCount > 0 && !loading && (
                  <span className="text-white/45"> · filtered</span>
                )}
              </span>
            </div>

            {/* Listings */}
            {loading ? (
              viewMode === "list" ? (
                <ListSkeleton />
              ) : (
                <CardSkeleton />
              )
            ) : filtered.length === 0 ? (
              <EmptyState
                hasActiveFilters={activeFilterCount > 0}
                onClearFilters={clearFilters}
                onClearDateWindow={dateWindow !== "all" ? () => setDateWindow("all") : null}
                dateWindowLabel={DATE_WINDOWS.find((d) => d.value === dateWindow)?.label ?? null}
              />
            ) : (
              <>
                {viewMode === "list" ? (
                  <InternshipList
                    items={paginated}
                    groupByCompany={groupByCompany}
                    onToggleApplied={toggleApplied}
                  />
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
                    {paginated.map((item) => (
                      <InternshipCard
                        key={item.id}
                        item={item}
                        appliedDate={appliedDates[item.id] ?? null}
                        notes={notesMap[item.id] ?? ""}
                        onNotesChange={(note) => updateNote(item.id, note)}
                        onToggleApplied={() => toggleApplied(item.id, item.applied)}
                      />
                    ))}
                  </div>
                )}

                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-4 pt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      className="gap-1.5 h-7 border-white/10 bg-white/[0.04] hover:bg-white/10 disabled:opacity-30 text-[12px]"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Prev
                    </Button>
                    <span className="text-[12px] text-white/50 tabular-nums">
                      Page <span className="text-white/80">{safePage}</span> of{" "}
                      <span className="text-white/80">{totalPages}</span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                      className="gap-1.5 h-7 border-white/10 bg-white/[0.04] hover:bg-white/10 disabled:opacity-30 text-[12px]"
                    >
                      Next
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      )}

      <MobileFilterSheet open={mobileFiltersOpen} onClose={() => setMobileFiltersOpen(false)}>
        <FilterRail
          dynamicSources={dynamicSources}
          dynamicSeasons={dynamicSeasons}
          selectedSources={selectedSources}
          tierFilter={tierFilter}
          selectedSeasons={selectedSeasons}
          minScore={minScore}
          selectedLocations={selectedLocations}
          locationText={locationText}
          includeKeywords={includeKeywords}
          excludeKeywords={excludeKeywords}
          setSelectedSources={setSelectedSources}
          setTierFilter={setTierFilter}
          setSelectedSeasons={setSelectedSeasons}
          setMinScore={setMinScore}
          setSelectedLocations={setSelectedLocations}
          setLocationText={setLocationText}
          setIncludeKeywords={setIncludeKeywords}
          setExcludeKeywords={setExcludeKeywords}
          activeFilterCount={activeFilterCount}
          onClearAll={clearFilters}
        />
      </MobileFilterSheet>

      <NotifModal
        open={notifModalOpen}
        onOpenChange={setNotifModalOpen}
        minScore={notifMinScore}
        onMinScoreChange={setNotifMinScore}
        sourceDownAlerts={sourceDownAlerts}
        onSourceDownAlertsChange={setSourceDownAlerts}
        tierFilter={notifTierFilter}
        onTierFilterChange={setNotifTierFilter}
        selectedSeasons={notifSeasons}
        onSeasonsToggle={(t) => setNotifSeasons((prev) => toggleArr(prev, t))}
        seasonOptions={dynamicSeasons.map(([token, count]) => ({ token, count }))}
        onSave={saveNotifSettings}
        saving={notifSaving}
        saved={notifSaved}
      />
    </div>
  );
}
