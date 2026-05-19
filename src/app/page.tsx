"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
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
  X,
  Bell,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import { InternshipCard } from "./_components/InternshipCard";
import { NotifModal } from "./_components/NotifModal";
import type { Internship, Stats, Sources, AppliedFilter, SortBy } from "./_lib/types";
import {
  SCORE_LABELS,
  LOCATION_PRESETS,
  PAGE_SIZE,
  SCORE_BADGE,
  SCORE_BADGE_FALLBACK,
} from "./_lib/constants";
import { timeAgo } from "./_lib/format";
import { lsGet, lsSet, LS_DATES_KEY, LS_NOTES_KEY } from "./_lib/storage";

export default function InternshipsPage() {
  const [internships, setInternships] = useState<Internship[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [locationText, setLocationText] = useState("");
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [includeKeywords, setIncludeKeywords] = useState<string[]>([]);
  const [excludeKeywords, setExcludeKeywords] = useState<string[]>([]);
  const [appliedFilter, setAppliedFilter] = useState<AppliedFilter>("all");
  const [kwIncludeInput, setKwIncludeInput] = useState("");
  const [kwExcludeInput, setKwExcludeInput] = useState("");

  // Sort & pagination
  const [sortBy, setSortBy] = useState<SortBy>("score");
  const [currentPage, setCurrentPage] = useState(1);

  // Applied tracking (localStorage)
  const [appliedDates, setAppliedDates] = useState<Record<string, string>>({});
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});

  // Notification settings
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  const [notifMinScore, setNotifMinScore] = useState(50);
  const [sourceDownAlerts, setSourceDownAlerts] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifSaved, setNotifSaved] = useState(false);

  // Track hydration so URL sync doesn't fire during initial mount
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

    const labels = parseList("labels");
    if (labels.length) setSelectedLabels(labels);

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

    const sort = sp.get("sort") as SortBy | null;
    if (sort === "newest" || sort === "posted" || sort === "score") setSortBy(sort);

    const page = Number(sp.get("page"));
    if (Number.isFinite(page) && page > 1) setCurrentPage(page);

    setHydrated(true);
  }, []);

  // Push filter state back to URL whenever it changes (after hydration)
  useEffect(() => {
    if (!hydrated) return;
    const params = new URLSearchParams();
    if (selectedSources.length) params.set("sources", selectedSources.join(","));
    if (selectedLabels.length) params.set("labels", selectedLabels.join(","));
    if (selectedLocations.length) params.set("locs", selectedLocations.join(","));
    if (includeKeywords.length) params.set("include", includeKeywords.join(","));
    if (excludeKeywords.length) params.set("exclude", excludeKeywords.join(","));
    if (minScore > 0) params.set("minScore", String(minScore));
    if (locationText) params.set("location", locationText);
    if (appliedFilter !== "all") params.set("applied", appliedFilter);
    if (sortBy !== "score") params.set("sort", sortBy);
    if (currentPage > 1) params.set("page", String(currentPage));

    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState({}, "", url);
  }, [
    hydrated,
    selectedSources, selectedLabels, selectedLocations,
    includeKeywords, excludeKeywords,
    minScore, locationText, appliedFilter, sortBy, currentPage,
  ]);

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedSources.length === 1) params.set("source", selectedSources[0]);
      if (minScore > 0) params.set("minScore", String(minScore));
      if (selectedLabels.length === 1) params.set("label", selectedLabels[0]);

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

      if (listRes.ok) {
        const data: Internship[] = await listRes.json();
        setInternships(data);
      }
      if (statsRes.ok) {
        const s: Stats = await statsRes.json();
        setStats(s);
      }
      if (sourcesRes.ok) {
        const src: Sources = await sourcesRes.json();
        setSources(src);
      }
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedSources, minScore, selectedLabels]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Reset to page 1 when filters or sort change (skip during initial hydration
  // so a shared URL like ?page=3&sources=Indeed lands on page 3, not page 1)
  useEffect(() => {
    if (!hydrated) return;
    setCurrentPage(1);
  }, [hydrated, selectedSources, selectedLabels, minScore, selectedLocations, locationText, includeKeywords, excludeKeywords, appliedFilter, sortBy]);

  // Load notification settings
  useEffect(() => {
    fetch("/api/internships/settings")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d) {
          setNotifMinScore(d.minScore ?? 50);
          setSourceDownAlerts(d.sourceDownAlerts ?? false);
        }
      })
      .catch(() => {});
  }, []);

  async function toggleApplied(id: string, current: boolean) {
    setInternships((prev) =>
      prev.map((i) => (i.id === id ? { ...i, applied: !current } : i))
    );
    const newDates = { ...appliedDates };
    if (!current) {
      newDates[id] = new Date().toISOString();
    } else {
      delete newDates[id];
    }
    setAppliedDates(newDates);
    lsSet(LS_DATES_KEY, newDates);

    try {
      await fetch(`/api/internships/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applied: !current }),
      });
    } catch {
      // revert on failure
      setInternships((prev) =>
        prev.map((i) => (i.id === id ? { ...i, applied: current } : i))
      );
      const reverted = { ...appliedDates };
      if (current) {
        reverted[id] = new Date().toISOString();
      } else {
        delete reverted[id];
      }
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
        body: JSON.stringify({ minScore: notifMinScore, sourceDownAlerts }),
      });
      setNotifSaved(true);
      setTimeout(() => setNotifSaved(false), 2000);
    } catch {}
    setNotifSaving(false);
  }

  function clearFilters() {
    setSelectedSources([]);
    setMinScore(0);
    setSelectedLabels([]);
    setLocationText("");
    setSelectedLocations([]);
    setIncludeKeywords([]);
    setExcludeKeywords([]);
    setAppliedFilter("all");
    setSortBy("score");
    setCurrentPage(1);
  }

  function toggleArr<T>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
  }

  function addKw(type: "include" | "exclude", val: string) {
    const trimmed = val.trim();
    if (!trimmed) return;
    if (type === "include") {
      setIncludeKeywords((prev) => prev.includes(trimmed) ? prev : [...prev, trimmed]);
      setKwIncludeInput("");
    } else {
      setExcludeKeywords((prev) => prev.includes(trimmed) ? prev : [...prev, trimmed]);
      setKwExcludeInput("");
    }
  }

  // Dynamic sources from stats
  const dynamicSources: string[] | null = stats?.bySource
    ? Object.entries(stats.bySource)
        .filter(([, count]) => count > 0)
        .map(([src]) => src)
        .sort()
    : null;

  // Client-side filter + sort
  const filtered = internships
    .filter((i) => {
      if (selectedSources.length > 0 && !selectedSources.includes(i.source)) return false;
      if (selectedLabels.length > 0 && !selectedLabels.includes(i.scoreLabel)) return false;
      if (minScore > 0 && (i.score ?? 0) < minScore) return false;
      if (appliedFilter === "applied" && !i.applied) return false;
      if (appliedFilter === "not-applied" && i.applied) return false;
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
      if (sortBy === "newest") {
        return new Date(b.seenAt ?? 0).getTime() - new Date(a.seenAt ?? 0).getTime();
      }
      if (sortBy === "posted") {
        return new Date(b.postedAt ?? 0).getTime() - new Date(a.postedAt ?? 0).getTime();
      }
      return (b.score ?? -1) - (a.score ?? -1);
    });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const exclusionSummary = stats?.exclusionCounts
    ? Object.entries(stats.exclusionCounts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")
    : null;

  const hasActiveFilters =
    selectedSources.length > 0 ||
    selectedLabels.length > 0 ||
    minScore > 0 ||
    selectedLocations.length > 0 ||
    locationText !== "" ||
    includeKeywords.length > 0 ||
    excludeKeywords.length > 0 ||
    appliedFilter !== "all";

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Briefcase className="h-6 w-6 text-white/70" />
          <div>
            <h1 className="text-xl font-semibold">Internships</h1>
            <p className="text-sm text-white/40">Live feed from the internship tracker</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setNotifModalOpen(true)}
            className="gap-2 border-white/10 bg-white/5 hover:bg-white/10"
          >
            <Bell className="h-3.5 w-3.5" />
            Notifications
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="gap-2 border-white/10 bg-white/5 hover:bg-white/10"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Offline state */}
      {offline && (
        <Card className="flex items-center gap-4 p-6 border-white/10 bg-white/[0.03]">
          <WifiOff className="h-8 w-8 text-white/30 shrink-0" />
          <div>
            <p className="font-medium text-white/70">Agent offline</p>
            <p className="text-sm text-white/40">
              Internship tracker is not running yet. Start it at{" "}
              <code className="text-xs bg-white/10 px-1 rounded">localhost:3001</code>.
            </p>
          </div>
        </Card>
      )}

      {!offline && (
        <>
          {/* Status bar */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 rounded-lg border border-white/10 bg-white/[0.03] text-sm">
            <span className="text-white/40">
              Last polled:{" "}
              <span className="text-white/70">{timeAgo(stats?.lastPolledAt ?? null)}</span>
            </span>
            <span className="text-white/40">
              Total:{" "}
              <span className="text-white/70 font-medium">{stats?.total ?? "—"}</span>
            </span>
            <span className="text-white/40" title={sources ? Object.entries(sources.byType).map(([k, v]) => `${k}: ${v}`).join(", ") : undefined}>
              Sources:{" "}
              <span className="text-white/70 font-medium">{sources?.total ?? "—"}</span>
            </span>
            {dynamicSources?.map((src) => {
              const count = stats?.bySource?.[src];
              return (
                <span key={src} className="flex items-center gap-1 text-white/50">
                  {src}
                  <span className="text-xs font-medium text-green-400">
                    ✓ {count}
                  </span>
                </span>
              );
            })}
            {exclusionSummary && (
              <span className="text-white/30 text-xs">
                Filtered: {exclusionSummary}
              </span>
            )}
          </div>

          {/* Filters panel */}
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white/60">Filters</span>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="text-xs text-white/40 hover:text-white/70 flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear filters
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {/* Source */}
              <div className="space-y-1.5">
                <label className="text-xs text-white/40 uppercase tracking-wider">Source</label>
                <div className="flex flex-wrap gap-1.5">
                  {dynamicSources === null ? (
                    // Loading skeleton
                    Array.from({ length: 4 }).map((_, i) => (
                      <span
                        key={i}
                        className="px-2.5 py-1 rounded-md text-xs border bg-white/5 border-white/10 text-transparent animate-pulse w-16"
                      >
                        &nbsp;
                      </span>
                    ))
                  ) : dynamicSources.length === 0 ? (
                    <span className="text-xs text-white/30">No sources yet</span>
                  ) : (
                    dynamicSources.map((s) => (
                      <button
                        key={s}
                        onClick={() => setSelectedSources((prev) => toggleArr(prev, s))}
                        className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                          selectedSources.includes(s)
                            ? "bg-white/15 border-white/30 text-white"
                            : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                        }`}
                      >
                        {s}
                      </button>
                    ))
                  )}
                </div>
              </div>

              {/* Score label */}
              <div className="space-y-1.5">
                <label className="text-xs text-white/40 uppercase tracking-wider">Score</label>
                <div className="flex flex-wrap gap-1.5">
                  {SCORE_LABELS.map((l) => (
                    <button
                      key={l}
                      onClick={() => setSelectedLabels((prev) => toggleArr(prev, l))}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        selectedLabels.includes(l)
                          ? SCORE_BADGE[l]
                          : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {/* Min score slider */}
              <div className="space-y-1.5">
                <label className="text-xs text-white/40 uppercase tracking-wider">
                  Min Score: <span className="text-white/70">{minScore}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                  className="w-full accent-white/70 h-1"
                />
              </div>

              {/* Location */}
              <div className="space-y-1.5">
                <label className="text-xs text-white/40 uppercase tracking-wider">Location</label>
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {LOCATION_PRESETS.map((l) => (
                    <button
                      key={l}
                      onClick={() => setSelectedLocations((prev) => toggleArr(prev, l))}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        selectedLocations.includes(l)
                          ? "bg-white/15 border-white/30 text-white"
                          : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <Input
                  placeholder="Other location…"
                  value={locationText}
                  onChange={(e) => setLocationText(e.target.value)}
                  className="h-7 text-xs bg-white/5 border-white/10"
                />
              </div>

              {/* Keywords include */}
              <div className="space-y-1.5">
                <label className="text-xs text-white/40 uppercase tracking-wider">Include keywords</label>
                <div className="flex gap-1.5">
                  <Input
                    placeholder="e.g. React"
                    value={kwIncludeInput}
                    onChange={(e) => setKwIncludeInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addKw("include", kwIncludeInput)}
                    className="h-7 text-xs bg-white/5 border-white/10"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs border-white/10 bg-white/5"
                    onClick={() => addKw("include", kwIncludeInput)}
                  >
                    Add
                  </Button>
                </div>
                {includeKeywords.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {includeKeywords.map((k) => (
                      <span
                        key={k}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 text-xs text-white/70"
                      >
                        {k}
                        <button onClick={() => setIncludeKeywords((p) => p.filter((x) => x !== k))}>
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Keywords exclude */}
              <div className="space-y-1.5">
                <label className="text-xs text-white/40 uppercase tracking-wider">Exclude keywords</label>
                <div className="flex gap-1.5">
                  <Input
                    placeholder="e.g. PhD"
                    value={kwExcludeInput}
                    onChange={(e) => setKwExcludeInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addKw("exclude", kwExcludeInput)}
                    className="h-7 text-xs bg-white/5 border-white/10"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs border-white/10 bg-white/5"
                    onClick={() => addKw("exclude", kwExcludeInput)}
                  >
                    Add
                  </Button>
                </div>
                {excludeKeywords.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {excludeKeywords.map((k) => (
                      <span
                        key={k}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/10 text-xs text-red-400"
                      >
                        {k}
                        <button onClick={() => setExcludeKeywords((p) => p.filter((x) => x !== k))}>
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Applied filter tabs + sort */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
              {(["all", "applied", "not-applied"] as AppliedFilter[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setAppliedFilter(tab)}
                  className={`px-3 py-1 rounded-md text-xs transition-colors capitalize ${
                    appliedFilter === tab
                      ? "bg-white/15 text-white"
                      : "text-white/40 hover:text-white/70"
                  }`}
                >
                  {tab === "not-applied" ? "Not applied" : tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40">Sort:</span>
              <Select value={sortBy} onValueChange={(v) => v && setSortBy(v as SortBy)}>
                <SelectTrigger size="sm" className="border-white/10 bg-white/5 text-white/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="score">Score</SelectItem>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="posted">Posted date</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Results count */}
          {!loading && (
            <p className="text-sm text-white/40">
              {filtered.length} listing{filtered.length !== 1 ? "s" : ""}
              {hasActiveFilters ? " (filtered)" : ""}
            </p>
          )}

          {/* Listings */}
          {loading ? (
            <div className="flex items-center justify-center py-16 text-white/30">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" />
              Loading internships…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-white/30 gap-2">
              <Briefcase className="h-10 w-10" />
              <p className="text-sm">No internships found.</p>
              <p className="text-xs">The tracker will poll every 15 minutes.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
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

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-4 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    className="gap-1.5 border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-30"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Prev
                  </Button>
                  <span className="text-sm text-white/40">
                    Page <span className="text-white/70">{safePage}</span> of{" "}
                    <span className="text-white/70">{totalPages}</span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    className="gap-1.5 border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-30"
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}

      <NotifModal
        open={notifModalOpen}
        onOpenChange={setNotifModalOpen}
        minScore={notifMinScore}
        onMinScoreChange={setNotifMinScore}
        sourceDownAlerts={sourceDownAlerts}
        onSourceDownAlertsChange={setSourceDownAlerts}
        onSave={saveNotifSettings}
        saving={notifSaving}
        saved={notifSaved}
      />
    </div>
  );
}
