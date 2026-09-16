"use client";

import { useCallback, useEffect, useState } from "react";
import type { Internship, Stats, Sources } from "../_lib/types";
import { ownerHeader } from "../_lib/ownerHeader";

/**
 * Loads the full corpus once (all filtering is client-side) plus the
 * filter-independent stats and sources. Only owners receive hidden rows;
 * the server verifies the owner header regardless of the query flag.
 */
export function useInternshipsData(isOwner: boolean, enabled: boolean) {
  const [internships, setInternships] = useState<Internship[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchList = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/internships${isOwner ? "?includeHidden=1" : ""}`, { signal, headers: ownerHeader() });
      if (res.status === 503) { setOffline(true); return; }
      setOffline(false);
      if (res.ok) setInternships(await res.json());
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      setOffline(true);
    }
  }, [isOwner]);

  const fetchStatsAndSources = useCallback(async () => {
    try {
      const [statsRes, sourcesRes] = await Promise.all([fetch("/api/internships/stats"), fetch("/api/internships/sources")]);
      if (statsRes.ok) setStats(await statsRes.json());
      if (sourcesRes.ok) setSources(await sourcesRes.json());
    } catch {
      // The list endpoint decides "offline"; a stats failure just leaves the header blank.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    setLoading(true);
    Promise.all([fetchList(abort.signal), fetchStatsAndSources()]).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [enabled, fetchList, fetchStatsAndSources]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchList(), fetchStatsAndSources()]);
    setRefreshing(false);
  }, [fetchList, fetchStatsAndSources]);

  return { internships, setInternships, stats, sources, offline, loading, refreshing, refresh };
}
