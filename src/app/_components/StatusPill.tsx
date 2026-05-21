"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle } from "lucide-react";
import { SOURCE_BADGE, SOURCE_BADGE_FALLBACK } from "../_lib/constants";
import { timeAgo } from "../_lib/format";

interface SourceEntry {
  name: string;
  total: number;
  last24h: number;
  last7d: number;
  lastSeenAt: string | null;
  lastCycleRaw?: number;
  lastCycleNetNew?: number;
}

interface Props {
  lastPolledAt: string | null;
  totalPostings: number | null;
  sourcesTotal: number | null;
  exclusionCounts: Record<string, number> | null;
}

function isDown(s: SourceEntry): boolean {
  return s.last24h === 0;
}
function isStaleEntry(s: SourceEntry): boolean {
  return s.last24h === 0 && s.last7d > 0;
}

export function StatusPill({ lastPolledAt, totalPostings, sourcesTotal, exclusionCounts }: Props) {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<SourceEntry[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/internships/source-health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { sources: SourceEntry[] } | null) => d && setHealth(d.sources))
      .catch(() => {});
  }, []);

  // Click-outside + ESC to close
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const downCount = health?.filter(isDown).length ?? 0;
  const staleCount = health?.filter(isStaleEntry).length ?? 0;
  const hardDown = downCount - staleCount;

  const tint =
    hardDown > 0 ? "text-red-400 border-red-500/30"
    : staleCount > 0 ? "text-amber-400 border-amber-500/30"
    : "text-emerald-400/80 border-emerald-500/25";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-md border bg-white/[0.03] hover:bg-white/[0.06] text-[12px] whitespace-nowrap transition-colors ${tint}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Source health"
      >
        {hardDown > 0 ? <AlertTriangle className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
        <span className="tabular-nums text-white/70">
          {totalPostings?.toLocaleString() ?? "—"}
        </span>
        <span className="hidden sm:inline text-white/35">·</span>
        <span className="hidden sm:inline text-white/55">
          {lastPolledAt ? timeAgo(lastPolledAt) : "never"}
        </span>
        {hardDown > 0 && <span className="text-[11px]">· {hardDown}</span>}
        {hardDown === 0 && staleCount > 0 && (
          <span className="hidden sm:inline text-[11px]">· {staleCount} quiet</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Source health"
          className="absolute right-0 top-full mt-2 w-[calc(100vw-1rem)] max-w-[420px] z-50 rounded-lg border border-white/15 bg-[oklch(0.18_0.005_260)] shadow-[0_8px_24px_oklch(0_0_0_/_50%)] p-3 space-y-3"
        >
          <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-white/50">
            <span>Source health</span>
            <span className="text-white/45 normal-case tracking-normal tabular-nums">
              {sourcesTotal ?? "—"} ATS targets
            </span>
          </div>

          {!health ? (
            <p className="text-xs text-white/40">Loading…</p>
          ) : health.length === 0 ? (
            <p className="text-xs text-white/40">No source data yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-1">
              {health.map((s) => {
                const down = isDown(s);
                const stale = isStaleEntry(s);
                const hard = down && !stale;
                return (
                  <div
                    key={s.name}
                    className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded border text-[11px] ${
                      hard ? "border-red-500/30 bg-red-500/5"
                      : stale ? "border-amber-500/20 bg-amber-500/5"
                      : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${SOURCE_BADGE[s.name] ?? SOURCE_BADGE_FALLBACK}`}>
                        {s.name}
                      </span>
                      <span className="text-white/40 truncate">
                        {s.lastSeenAt ? timeAgo(s.lastSeenAt) : "never"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 tabular-nums">
                      <span>
                        <span className={down ? "text-red-400/80" : "text-white/60"}>{s.last24h}</span>
                        <span className="text-white/20"> / </span>
                        <span>{s.last7d}</span>
                        <span className="text-white/20"> / </span>
                        <span className="text-white/40">{s.total}</span>
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

          {exclusionCounts && Object.keys(exclusionCounts).length > 0 && (
            <div className="pt-2 border-t border-white/10 text-[10px] text-white/40">
              Filtered out:{" "}
              {Object.entries(exclusionCounts)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => `${v} ${k}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
