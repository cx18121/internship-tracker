"use client";

import { ExternalLink, MapPin } from "lucide-react";
import type { Internship } from "../_lib/types";
import {
  SCORE_BADGE,
  SCORE_BADGE_FALLBACK,
  SOURCE_DOT,
  SOURCE_DOT_FALLBACK,
} from "../_lib/constants";
import { formatDate, isStale } from "../_lib/format";
import { formatSeasonLabel } from "@/lib/seasons";

// Shared grid template — used by the row AND the header in page.tsx so
// columns align across every row.
//
// Drop Seen (redundant w/ Posted) and Source-as-column (now a dot prefix
// on Company) to give Title the freed real estate.
export const LIST_GRID_COLS =
  "grid-cols-[4rem_9rem_minmax(0,1fr)_10rem_6rem_4rem_5rem]";

interface Props {
  item: Internship;
  onToggleApplied: () => void;
}

export function InternshipRow({ item, onToggleApplied }: Props) {
  const primarySeason = (item.season ?? [])[0];

  return (
    <div
      className={`grid ${LIST_GRID_COLS} items-center gap-2 px-3 py-2 rounded border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10 transition-colors text-sm ${
        item.applied ? "opacity-60" : ""
      }`}
    >
      {/* Score */}
      <span
        className={`justify-self-start text-[11px] font-semibold px-1.5 py-0.5 rounded ${
          SCORE_BADGE[item.scoreLabel] ?? SCORE_BADGE_FALLBACK
        }`}
      >
        {item.scoreLabel ?? "—"}
        {item.score != null ? ` ${item.score}` : ""}
      </span>

      {/* Company (with source-color dot prefix) */}
      <span className="flex items-center gap-1.5 min-w-0">
        <span
          className={`shrink-0 h-1.5 w-1.5 rounded-full ${SOURCE_DOT[item.source] ?? SOURCE_DOT_FALLBACK}`}
          title={item.source}
        />
        <span className="font-medium text-white truncate">{item.company}</span>
      </span>

      {/* Title — gets the freed real estate */}
      <span className="text-white/55 truncate min-w-0">{item.title}</span>

      {/* Location */}
      <span className="text-[11px] text-white/40 truncate flex items-center gap-1">
        {item.location && <MapPin className="h-3 w-3 shrink-0" />}
        <span className="truncate">{item.location || "—"}</span>
      </span>

      {/* Season */}
      <span className="justify-self-start text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/55 truncate max-w-full">
        {primarySeason ? formatSeasonLabel(primarySeason) : "—"}
      </span>

      {/* Posted */}
      <span className="text-[11px] text-white/30 truncate flex items-center gap-1">
        {item.postedAt ? formatDate(item.postedAt) : "—"}
        {item.postedAt && isStale(item.postedAt) && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400">!</span>
        )}
      </span>

      {/* Actions */}
      <div className="flex items-center gap-1 justify-self-end">
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2 py-1 rounded text-[11px] border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 hover:text-white flex items-center gap-1"
        >
          <ExternalLink className="h-3 w-3" />
          Apply
        </a>
        <button
          onClick={onToggleApplied}
          className={`px-2 py-1 rounded text-[11px] border transition-colors ${
            item.applied
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
              : "border-white/10 bg-white/5 text-white/40 hover:text-white/70"
          }`}
          title={item.applied ? "Mark unapplied" : "Mark applied"}
        >
          {item.applied ? "✓" : "○"}
        </button>
      </div>
    </div>
  );
}
