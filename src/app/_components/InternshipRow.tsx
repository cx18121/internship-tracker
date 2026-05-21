"use client";

import { ExternalLink, MapPin, Check } from "lucide-react";
import type { Internship } from "../_lib/types";
import {
  SCORE_BADGE,
  SCORE_BADGE_FALLBACK,
  SOURCE_DOT,
  SOURCE_DOT_FALLBACK,
} from "../_lib/constants";
import { formatDate, isStale } from "../_lib/format";
import { formatSeasonLabel } from "@/lib/seasons";

// Shared grid template — used by the row AND the header in InternshipList
// so columns align across every row.
//
// Mobile (< md): a 4-col layout — Score · Company+title (stacked) · Posted · Apply.
// Desktop (md+): the full 7-col operator template.
export const LIST_GRID_COLS =
  "grid-cols-[3.5rem_minmax(0,1fr)_4.5rem_4.5rem] md:grid-cols-[4rem_minmax(0,11rem)_minmax(0,1fr)_minmax(0,10rem)_minmax(0,6rem)_minmax(0,5rem)_minmax(0,5.5rem)]";

interface Props {
  item: Internship;
  onToggleApplied: () => void;
}

export function InternshipRow({ item, onToggleApplied }: Props) {
  const primarySeason = (item.season ?? [])[0];

  return (
    <div
      className={`grid ${LIST_GRID_COLS} items-center gap-2 md:gap-3 px-2.5 md:px-3 py-2 rounded border transition-colors text-[13px] ${
        item.applied
          ? "border-transparent bg-transparent opacity-55 hover:opacity-100 hover:bg-white/[0.02]"
          : "border-white/[0.05] bg-white/[0.015] hover:bg-white/[0.04] hover:border-white/[0.1]"
      }`}
    >
      {/* Score */}
      <span
        className={`justify-self-start text-[10.5px] font-semibold tabular-nums px-1.5 py-0.5 rounded ${
          SCORE_BADGE[item.scoreLabel] ?? SCORE_BADGE_FALLBACK
        }`}
      >
        {item.scoreLabel ?? "—"}
        {item.score != null ? ` ${item.score}` : ""}
      </span>

      {/* Company — desktop column. On mobile this slot holds company + title stacked. */}
      <div className="min-w-0">
        <span className="flex items-center gap-1.5 min-w-0">
          <span
            className={`shrink-0 h-1.5 w-1.5 rounded-full ${SOURCE_DOT[item.source] ?? SOURCE_DOT_FALLBACK}`}
            title={item.source}
          />
          <span className="font-medium text-white truncate">{item.company}</span>
        </span>
        {/* Title appears under company on mobile only; desktop has its own column */}
        <span className="md:hidden block text-[11.5px] text-white/55 truncate mt-0.5">
          {item.title}
        </span>
      </div>

      {/* Title — desktop column only */}
      <span className="hidden md:block text-white/60 truncate min-w-0">{item.title}</span>

      {/* Location — desktop only */}
      <span className="hidden md:flex text-[12px] text-white/50 truncate items-center gap-1 min-w-0">
        {item.location && <MapPin className="h-3 w-3 shrink-0 text-white/40" />}
        <span className="truncate">{item.location || "—"}</span>
      </span>

      {/* Season — desktop only */}
      <span className="hidden md:inline justify-self-start text-[10.5px] px-1.5 py-0.5 rounded bg-white/[0.05] text-white/55 truncate max-w-full">
        {primarySeason ? formatSeasonLabel(primarySeason) : "—"}
      </span>

      {/* Posted — visible on both, but narrower on mobile */}
      <span className="text-[11px] text-white/45 tabular-nums flex items-center gap-1 truncate">
        {item.postedAt ? formatDate(item.postedAt) : "—"}
        {item.postedAt && isStale(item.postedAt) && (
          <span
            className="text-[9px] px-1 py-px rounded bg-amber-500/12 text-amber-300 border border-amber-500/20"
            title="Posted >30 days ago"
          >
            !
          </span>
        )}
      </span>

      {/* Actions */}
      <div className="flex items-center gap-1 justify-self-end">
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Apply to ${item.title} at ${item.company}`}
          className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium bg-white/10 hover:bg-white/20 text-white/85 transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          <span className="hidden md:inline">Apply</span>
        </a>
        <button
          onClick={onToggleApplied}
          aria-label={item.applied ? "Mark unapplied" : "Mark applied"}
          aria-pressed={item.applied}
          className={`h-6 w-6 inline-flex items-center justify-center rounded transition-colors ${
            item.applied
              ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
              : "bg-transparent text-white/35 hover:text-white/70 hover:bg-white/[0.05]"
          }`}
          title={item.applied ? "Mark unapplied" : "Mark applied"}
        >
          {item.applied ? <Check className="h-3.5 w-3.5" /> : <span className="text-[14px] leading-none">○</span>}
        </button>
      </div>
    </div>
  );
}
