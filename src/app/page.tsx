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
import { InternshipList } from "./_components/InternshipList";
import { NotifModal } from "./_components/NotifModal";
import { StatusPill } from "./_components/StatusPill";
import { FilterRail } from "./_components/FilterRail";
import { MobileFilterSheet } from "./_components/MobileFilterSheet";
import { ListSkeleton, CardSkeleton, EmptyState } from "./_components/Skeletons";
import { ActiveFilterChips } from "./_components/ActiveFilterChips";
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
  const [searchText, setSearchText] = useState("");
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
  const [showHidden, setShowHidden] = useState(false);

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

  // Posting ids whose description is expanded inline (list view)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // Per-row in-flight PATCH guard so a fast double-click on the applied
  // toggle can't race-fire stale requests and end in the wrong final state.
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  function toggleExpand(id: string): void {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setPending(id: string, on: boolean): void {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Notification settings
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  const [notifMinScore, setNotifMinScore] = useState(50);
  const [sourceDownAlerts, setSourceDownAlerts] = useState(false);
  const [notifTierFilter, setNotifTierFilter] = useState<TierFilter>("all");
  const [notifSeasons, setNotifSeasons] = useState<string[]>([]);
  const [notifExcludedSources, setNotifExcludedSources] = useState<string[]>([]);
  const [notifExcludeNonUS, setNotifExcludeNonUS] = useState(false);
  const [notifIncludeKeywords, setNotifIncludeKeywords] = useState<string[]>([]);
  const [notifExcludeKeywords, setNotifExcludeKeywords] = useState<string[]>([]);
  const [notifSkipApplied, setNotifSkipApplied] = useState(true);
  const [notifSkipHidden, setNotifSkipHidden] = useState(true);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifSaved, setNotifSaved] = useState(false);
  // Null when no error; set to a short string when the last save attempt
  // returned non-ok or threw. Surface in NotifModal next to the Save button
  // so a failed POST doesn't look identical to a successful one.
  const [notifError, setNotifError] = useState<string | null>(null);

  // Hydration guard — URL sync waits until initial state is loaded
  const [hydrated, setHydrated] = useState(false);

  // Search input ref for `/` keyboard shortcut
  const searchInputRef = useRef<HTMLInputElement>(null);

  // `/` focuses the search input. Skip when the user is already typing.
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

    const q = sp.get("q");
    if (q) setSearchText(q);

    if (sp.get("showHidden") === "1") setShowHidden(true);

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
    if (searchText) params.set("q", searchText);
    if (showHidden) params.set("showHidden", "1");
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
    searchText, showHidden,
    viewMode, groupByCompany, sortBy, currentPage,
  ]);

  const fetchData = useCallback(async (isRefresh = false, signal?: AbortSignal) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedSources.length === 1) params.set("source", selectedSources[0]);
      if (minScore > 0) params.set("minScore", String(minScore));
      // Always fetch hidden so the toggle is instant; filter client-side.
      params.set("includeHidden", "1");

      const [listRes, statsRes, sourcesRes] = await Promise.all([
        fetch(`/api/internships?${params.toString()}`, { signal }),
        fetch("/api/internships/stats", { signal }),
        fetch("/api/internships/sources", { signal }),
      ]);

      if (listRes.status === 503 || statsRes.status === 503) {
        setOffline(true);
        return;
      }
      setOffline(false);

      if (listRes.ok) setInternships(await listRes.json());
      if (statsRes.ok) setStats(await statsRes.json());
      if (sourcesRes.ok) setSources(await sourcesRes.json());
    } catch (err) {
      // AbortError = a newer fetch superseded this one; leave UI alone so
      // the in-flight request's setInternships doesn't get stomped by a
      // stale "offline" flag.
      if ((err as { name?: string })?.name === "AbortError") return;
      setOffline(true);
    } finally {
      if (signal?.aborted) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedSources, minScore]);

  // Abort any in-flight fetchData when filters change again before it lands —
  // otherwise a slow request from filter state N can overwrite a fast
  // request from filter state N+1, leaving the UI showing stale data.
  useEffect(() => {
    const abort = new AbortController();
    fetchData(false, abort.signal);
    return () => abort.abort();
  }, [fetchData]);

  // Reset to page 1 when filters or sort change. Skip during initial hydration
  // so a shared URL like ?page=3&sources=Indeed lands on page 3, not page 1.
  useEffect(() => {
    if (!hydrated) return;
    setCurrentPage(1);
  }, [
    hydrated,
    selectedSources, minScore, selectedLocations, locationText,
    includeKeywords, excludeKeywords, appliedFilter, tierFilter,
    selectedSeasons, dateWindow, sortBy, searchText, showHidden,
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
          if (Array.isArray(d.excludedSources)) setNotifExcludedSources(d.excludedSources);
          if (typeof d.excludeNonUS === "boolean") setNotifExcludeNonUS(d.excludeNonUS);
          if (Array.isArray(d.includeKeywords)) setNotifIncludeKeywords(d.includeKeywords);
          if (Array.isArray(d.excludeKeywords)) setNotifExcludeKeywords(d.excludeKeywords);
          if (typeof d.skipApplied === "boolean") setNotifSkipApplied(d.skipApplied);
          if (typeof d.skipHidden === "boolean") setNotifSkipHidden(d.skipHidden);
        }
      })
      .catch(() => {});
  }, []);

  async function toggleApplied(id: string, current: boolean) {
    // Per-row pending guard. Double-clicks while a PATCH is in flight are
    // ignored so we can't race two stale requests and end up wrong-side-up.
    if (pendingIds.has(id)) return;
    setPending(id, true);

    setInternships((prev) => prev.map((i) => (i.id === id ? { ...i, applied: !current } : i)));
    // Functional update so rapid toggles on different rows compose on top
    // of each other's writes — a captured `appliedDates` snapshot would let
    // the second click stomp the first row's entry in state and localStorage.
    setAppliedDates((prev) => {
      const next = { ...prev };
      if (!current) next[id] = new Date().toISOString();
      else delete next[id];
      lsSet(LS_DATES_KEY, next);
      return next;
    });

    let ok = false;
    try {
      const res = await fetch(`/api/internships/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applied: !current }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }

    if (!ok) {
      // fetch() resolves with res.ok === false for 4xx/5xx, so a non-thrown
      // failed PATCH would silently leave the UI in the optimistic state
      // while the DB rejected the change. Roll back explicitly.
      setInternships((prev) => prev.map((i) => (i.id === id ? { ...i, applied: current } : i)));
      setAppliedDates((prev) => {
        const next = { ...prev };
        if (current) next[id] = new Date().toISOString();
        else delete next[id];
        lsSet(LS_DATES_KEY, next);
        return next;
      });
    }
    setPending(id, false);
  }

  async function patchHidden(id: string, next: boolean): Promise<void> {
    if (pendingIds.has(id)) return;
    setPending(id, true);

    const prevHidden = !next;
    setInternships((prev) => prev.map((i) => (i.id === id ? { ...i, hidden: next } : i)));

    let ok = false;
    try {
      const res = await fetch(`/api/internships/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: next }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }

    if (!ok) {
      setInternships((prev) => prev.map((i) => (i.id === id ? { ...i, hidden: prevHidden } : i)));
    }
    setPending(id, false);
  }

  function hidePosting(id: string): void {
    void patchHidden(id, true);
  }
  function unhidePosting(id: string): void {
    void patchHidden(id, false);
  }

  function updateNote(id: string, note: string) {
    // Functional update + lsSet inside the updater so two rapid edits on
    // different ids don't stomp each other via stale `notesMap` closure.
    setNotesMap((prev) => {
      const next = { ...prev, [id]: note };
      if (!note) delete next[id];
      lsSet(LS_NOTES_KEY, next);
      return next;
    });
  }

  async function saveNotifSettings() {
    setNotifSaving(true);
    setNotifError(null);
    try {
      const res = await fetch("/api/internships/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minScore: notifMinScore,
          sourceDownAlerts,
          tierFilter: notifTierFilter,
          seasons: notifSeasons,
          excludedSources: notifExcludedSources,
          excludeNonUS: notifExcludeNonUS,
          includeKeywords: notifIncludeKeywords,
          excludeKeywords: notifExcludeKeywords,
          skipApplied: notifSkipApplied,
          skipHidden: notifSkipHidden,
        }),
      });
      // fetch() resolves on 4xx/5xx, so we have to inspect res.ok before
      // claiming success — otherwise a server-side failure looks identical
      // to a successful save in the UI.
      if (res.ok) {
        setNotifSaved(true);
        setTimeout(() => setNotifSaved(false), 2000);
      } else {
        setNotifError("Save failed");
      }
    } catch {
      setNotifError("Save failed");
    }
    setNotifSaving(false);
  }

  function clearFilters() {
    setSearchText("");
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

  // Every keyword that appears on at least one internship's matchedKeywords
  // anywhere in the loaded corpus. Used by FilterRail to dim keyword chips
  // the user typed that won't match anything — the include/exclude filter
  // operates on the scorer's tag set, not free text, so a typed keyword
  // missing from the corpus silently wipes out all results.
  const knownKeywords = useMemo(() => {
    const set = new Set<string>();
    for (const i of internships) {
      for (const k of i.matchedKeywords ?? []) set.add(k.toLowerCase());
    }
    return set;
  }, [internships]);

  // Date-window cutoff in ms. `null` means no date filter (all time).
  const windowCutoff = useMemo(() => {
    const cfg = DATE_WINDOWS.find((d) => d.value === dateWindow);
    if (!cfg || cfg.days == null) return null;
    return Date.now() - cfg.days * 24 * 60 * 60 * 1000;
  }, [dateWindow]);

  // Client-side filter + sort
  const searchLower = searchText.trim().toLowerCase();
  const filtered = internships
    .filter((i) => {
      // Hidden — exclude unless user opted to show
      if (i.hidden && !showHidden) return false;
      // Free-text search: substring match on company OR title OR location
      if (searchLower) {
        const hay = `${i.company} ${i.title} ${i.location ?? ""}`.toLowerCase();
        if (!hay.includes(searchLower)) return false;
      }
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
    (searchText !== "" ? 1 : 0) +
    (selectedSources.length > 0 ? 1 : 0) +
    (minScore > 0 ? 1 : 0) +
    (selectedLocations.length > 0 ? 1 : 0) +
    (locationText !== "" ? 1 : 0) +
    (includeKeywords.length > 0 ? 1 : 0) +
    (excludeKeywords.length > 0 ? 1 : 0) +
    (tierFilter !== "all" ? 1 : 0) +
    (selectedSeasons.length > 0 ? 1 : 0) +
    (dateWindow !== "all" ? 1 : 0);

  const hiddenCount = useMemo(
    () => internships.filter((i) => i.hidden).length,
    [internships],
  );

  // Tab counts. Computed pre-applied-filter so the chip numbers show the
  // available scope before the user clicks, not the current selection's
  // intersection with itself. All other filters DO apply.
  const tabCounts = useMemo(() => {
    let all = 0,
      applied = 0;
    for (const i of internships) {
      // Mirror the same filters as the main list, except applied-filter.
      if (i.hidden && !showHidden) continue;
      if (searchLower) {
        const hay = `${i.company} ${i.title} ${i.location ?? ""}`.toLowerCase();
        if (!hay.includes(searchLower)) continue;
      }
      if (selectedSources.length > 0 && !selectedSources.includes(i.source)) continue;
      if (minScore > 0 && (i.score ?? 0) < minScore) continue;
      if (tierFilter === "elite" && !isElite(i.company)) continue;
      if (tierFilter === "top-or-better" && !isTopOrBetter(i.company)) continue;
      if (selectedSeasons.length > 0) {
        const tokens = i.season ?? parseSeason(i.title);
        if (!tokens.some((t) => selectedSeasons.includes(t))) continue;
      }
      if (windowCutoff !== null) {
        const seen = new Date(i.seenAt ?? 0).getTime();
        if (!Number.isFinite(seen) || seen < windowCutoff) continue;
      }
      if (selectedLocations.length > 0 || locationText) {
        const loc = i.location.toLowerCase();
        const locMatch = selectedLocations.some((l) => loc.includes(l.toLowerCase()));
        const textMatch = locationText ? loc.includes(locationText.toLowerCase()) : false;
        if (!locMatch && !textMatch && !(selectedLocations.length === 0)) continue;
        if (selectedLocations.length === 0 && locationText && !textMatch) continue;
      }
      if (includeKeywords.length > 0) {
        const kws = (i.matchedKeywords ?? []).map((k) => k.toLowerCase());
        if (!includeKeywords.some((k) => kws.includes(k.toLowerCase()))) continue;
      }
      if (excludeKeywords.length > 0) {
        const kws = (i.matchedKeywords ?? []).map((k) => k.toLowerCase());
        if (excludeKeywords.some((k) => kws.includes(k.toLowerCase()))) continue;
      }
      all++;
      if (i.applied) applied++;
    }
    return { all, applied, open: all - applied };
  }, [
    internships, showHidden, searchLower, selectedSources, minScore, tierFilter,
    selectedSeasons, windowCutoff, selectedLocations, locationText,
    includeKeywords, excludeKeywords,
  ]);

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
              knownKeywords={knownKeywords}
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
            {/* Toolbar row 1: search · applied scope · time window · sort · count */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2 border-b border-white/[0.06]">
              {/* Search — primary lookup affordance, focused with `/`. */}
              <div className="relative flex-1 min-w-[180px] max-w-[260px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/35 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setSearchText("");
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Search company, title, location…"
                  aria-label="Search postings"
                  className="w-full h-7 pl-7 pr-7 rounded-md bg-white/[0.04] border border-white/10 text-[12px] text-white/85 placeholder:text-white/35 focus:outline-none focus:border-white/25 focus:bg-white/[0.06] transition-colors"
                />
                {searchText ? (
                  <button
                    type="button"
                    onClick={() => setSearchText("")}
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
                  const active = appliedFilter === tab;
                  return (
                    <button
                      key={tab}
                      onClick={() => setAppliedFilter(tab)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors ${
                        active
                          ? "bg-white/15 text-white"
                          : "text-white/45 hover:text-white/70"
                      }`}
                    >
                      <span>{tab === "not-applied" ? "Open" : tab === "applied" ? "Applied" : "All"}</span>
                      <span
                        className={`tabular-nums text-[10px] ${
                          active ? "text-white/65" : "text-white/35"
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
                {hiddenCount > 0 && !loading && (
                  <>
                    <span className="text-white/30"> · </span>
                    <button
                      onClick={() => setShowHidden((v) => !v)}
                      className="inline-flex items-center gap-1 text-white/55 hover:text-white/85 transition-colors normal-nums underline-offset-4 hover:underline"
                      title={showHidden ? "Hide hidden postings" : "Show hidden postings"}
                    >
                      <Eye className="h-3 w-3" />
                      {hiddenCount} hidden
                      {showHidden && <span className="text-emerald-300/80"> · shown</span>}
                    </button>
                  </>
                )}
              </span>
            </div>

            {/* Active filter chips — visible only when at least one filter is set */}
            <ActiveFilterChips
              searchText={searchText}
              selectedSources={selectedSources}
              tierFilter={tierFilter}
              selectedSeasons={selectedSeasons}
              minScore={minScore}
              selectedLocations={selectedLocations}
              locationText={locationText}
              includeKeywords={includeKeywords}
              excludeKeywords={excludeKeywords}
              dateWindow={dateWindow}
              setSearchText={setSearchText}
              setSelectedSources={setSelectedSources}
              setTierFilter={setTierFilter}
              setSelectedSeasons={setSelectedSeasons}
              setMinScore={setMinScore}
              setSelectedLocations={setSelectedLocations}
              setLocationText={setLocationText}
              setIncludeKeywords={setIncludeKeywords}
              setExcludeKeywords={setExcludeKeywords}
              setDateWindow={setDateWindow}
              onClearAll={clearFilters}
            />

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
                    sortBy={sortBy}
                    expandedIds={expandedIds}
                    pendingIds={pendingIds}
                    onToggleApplied={toggleApplied}
                    onHide={(id) => {
                      const item = internships.find((i) => i.id === id);
                      if (!item) return;
                      if (item.hidden) unhidePosting(id);
                      else hidePosting(id);
                    }}
                    onToggleExpand={toggleExpand}
                  />
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
                    {paginated.map((item) => (
                      <InternshipCard
                        key={item.id}
                        item={item}
                        appliedDate={appliedDates[item.id] ?? null}
                        notes={notesMap[item.id] ?? ""}
                        pending={pendingIds.has(item.id)}
                        onNotesChange={(note) => updateNote(item.id, note)}
                        onToggleApplied={() => toggleApplied(item.id, item.applied)}
                        onHide={() => (item.hidden ? unhidePosting(item.id) : hidePosting(item.id))}
                      />
                    ))}
                  </div>
                )}

                {totalPages > 1 && (
                  <div className="sticky bottom-0 z-10 flex items-center justify-center gap-3 pt-4 pb-3 mt-2 bg-gradient-to-t from-[oklch(0.13_0.005_260)] via-[oklch(0.13_0.005_260_/_0.95)] to-transparent">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      className="gap-1.5 h-7 border-white/10 bg-[oklch(0.18_0.005_260)] hover:bg-white/10 disabled:opacity-30 text-[12px]"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Prev
                    </Button>
                    <span className="text-[12px] text-white/55 tabular-nums whitespace-nowrap">
                      <span className="text-white/85">
                        {((safePage - 1) * PAGE_SIZE + 1).toLocaleString()}
                        {"–"}
                        {Math.min(safePage * PAGE_SIZE, filtered.length).toLocaleString()}
                      </span>
                      {" of "}
                      <span className="text-white/85">{filtered.length.toLocaleString()}</span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                      className="gap-1.5 h-7 border-white/10 bg-[oklch(0.18_0.005_260)] hover:bg-white/10 disabled:opacity-30 text-[12px]"
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
          knownKeywords={knownKeywords}
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
        dynamicSources={dynamicSources}
        excludedSources={notifExcludedSources}
        onExcludedSourcesChange={setNotifExcludedSources}
        excludeNonUS={notifExcludeNonUS}
        onExcludeNonUSChange={setNotifExcludeNonUS}
        includeKeywords={notifIncludeKeywords}
        excludeKeywords={notifExcludeKeywords}
        knownKeywords={knownKeywords}
        onIncludeKeywordsChange={setNotifIncludeKeywords}
        onExcludeKeywordsChange={setNotifExcludeKeywords}
        skipApplied={notifSkipApplied}
        skipHidden={notifSkipHidden}
        onSkipAppliedChange={setNotifSkipApplied}
        onSkipHiddenChange={setNotifSkipHidden}
        onSave={saveNotifSettings}
        saving={notifSaving}
        saved={notifSaved}
        error={notifError}
      />
    </div>
  );
}
