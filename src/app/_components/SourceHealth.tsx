"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SOURCE_BADGE, SOURCE_BADGE_FALLBACK } from "../_lib/constants";
import { timeAgo } from "../_lib/format";

interface SourceEntry {
  name: string;
  total: number;
  last24h: number;
  last7d: number;
  lastSeenAt: string | null;
  lastCycleRaw?: number;     // items fetched by this source last cycle (pre-dedup)
  lastCycleNetNew?: number;  // items that actually got stored (post-dedup)
}

interface HealthResponse {
  sources: SourceEntry[];
}

function isDown(entry: SourceEntry): boolean {
  // A source is "down" if we haven't seen any new records in the last 24h.
  // Total records existing isn't enough — we want fresh activity.
  return entry.last24h === 0;
}

function isStale(entry: SourceEntry): boolean {
  // "Stale" = last seen anywhere from 24h to 7 days ago. Worth flagging but
  // not a red alarm — some sources legitimately go quiet on weekends/holidays.
  return entry.last24h === 0 && entry.last7d > 0;
}

export function SourceHealth() {
  const [data, setData] = useState<SourceEntry[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/internships/source-health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: HealthResponse | null) => {
        if (cancelled || !d) return;
        setData(d.sources);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!data || data.length === 0) return null;

  const downCount = data.filter(isDown).length;
  const staleCount = data.filter(isStale).length;
  const hardDown = downCount - staleCount; // no records in 7+ days

  return (
    <Card className="border-white/10 bg-white/[0.03] p-3">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-white/50" />
          <span className="text-xs uppercase tracking-wider text-white/50">Source health</span>
          {hardDown > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-red-400">
              <AlertTriangle className="h-3 w-3" />
              {hardDown} down
            </span>
          )}
          {staleCount > 0 && hardDown === 0 && (
            <span className="text-[10px] text-amber-400">{staleCount} quiet</span>
          )}
          {downCount === 0 && (
            <span className="text-[10px] text-green-400">all healthy</span>
          )}
        </div>
        <span className="text-[10px] text-white/30">{collapsed ? "show" : "hide"}</span>
      </button>

      {!collapsed && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-1.5 mt-3">
          {data.map((s) => {
            const down = isDown(s);
            const stale = isStale(s);
            const hard = down && !stale;
            return (
              <div
                key={s.name}
                className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded border ${
                  hard
                    ? "border-red-500/30 bg-red-500/5"
                    : stale
                    ? "border-amber-500/20 bg-amber-500/5"
                    : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                      SOURCE_BADGE[s.name] ?? SOURCE_BADGE_FALLBACK
                    }`}
                  >
                    {s.name}
                  </span>
                  <span className="text-[10px] text-white/40 truncate">
                    {s.lastSeenAt ? timeAgo(s.lastSeenAt) : "never"}
                  </span>
                </div>
                <div className="text-[10px] text-white/40 shrink-0 tabular-nums flex items-center gap-1.5">
                  <span>
                    <span className={down ? "text-red-400/80" : "text-white/60"}>{s.last24h}</span>
                    <span className="text-white/20"> / </span>
                    <span>{s.last7d}</span>
                    <span className="text-white/20"> / </span>
                    <span>{s.total}</span>
                  </span>
                  {(s.lastCycleRaw ?? 0) > 0 && (
                    <span
                      className="text-white/30 border-l border-white/10 pl-1.5"
                      title={`Last cycle: ${s.lastCycleNetNew ?? 0} net-new / ${s.lastCycleRaw} fetched`}
                    >
                      <span className={(s.lastCycleNetNew ?? 0) > 0 ? "text-emerald-400/80" : "text-white/40"}>
                        +{s.lastCycleNetNew ?? 0}
                      </span>
                      <span className="text-white/20">/{s.lastCycleRaw}</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
