"use client";

import { ExternalLink, MapPin, Check, Eye, EyeOff, ChevronDown } from "lucide-react";
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
// Mobile (< md): 4 cols — Score · Company+title (stacked) · Posted · Apply.
// Desktop (md+): the full 8-col operator template (Score · Company · Title
//   · Salary · Location · Season · Posted · Actions).
export const LIST_GRID_COLS =
  "grid-cols-[3.5rem_minmax(0,1fr)_4.5rem_4.5rem] md:grid-cols-[4rem_minmax(0,11rem)_minmax(0,1fr)_minmax(0,5.5rem)_minmax(0,9rem)_minmax(0,6rem)_minmax(0,5rem)_minmax(0,5.5rem)]";

interface Props {
  item: Internship;
  expanded: boolean;
  pending?: boolean;
  onToggleApplied: () => void;
  onHide: () => void;
  onToggleExpand: () => void;
}

export function InternshipRow({
  item,
  expanded,
  pending = false,
  onToggleApplied,
  onHide,
  onToggleExpand,
}: Props) {
  const primarySeason = (item.season ?? [])[0];

  function handleRowClick(e: React.MouseEvent<HTMLDivElement>) {
    // Ignore clicks on action buttons or links inside the row.
    if ((e.target as HTMLElement).closest("a, button")) return;
    onToggleExpand();
  }

  function handleRowKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" && e.key !== " ") return;
    if ((e.target as HTMLElement).closest("a, button, input, textarea")) return;
    e.preventDefault();
    onToggleExpand();
  }

  return (
    <div
      className={`rounded border transition-colors ${
        item.applied
          ? "border-transparent bg-transparent opacity-55 hover:opacity-100"
          : "border-white/[0.05] bg-white/[0.015] hover:border-white/[0.1]"
      } ${expanded ? "border-white/15 bg-white/[0.03]" : ""}`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
        className={`group grid ${LIST_GRID_COLS} items-center gap-2 md:gap-3 px-2.5 md:px-3 py-2 cursor-pointer hover:bg-white/[0.025] transition-colors text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-white/30 rounded`}
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

      {/* Company — desktop column. On mobile this slot holds company + title stacked.
          The colored dot encodes source visually; sr-only text keeps the same
          information available to screen readers. */}
      <div className="min-w-0">
        <span className="flex items-center gap-1.5 min-w-0">
          <span
            className={`shrink-0 h-1.5 w-1.5 rounded-full ${SOURCE_DOT[item.source] ?? SOURCE_DOT_FALLBACK}`}
            aria-hidden="true"
            title={`Source: ${item.source}`}
          />
          <span className="sr-only">Source: {item.source}.</span>
          <span className="font-medium text-white truncate">{item.company}</span>
        </span>
        {/* Title appears under company on mobile only; desktop has its own column */}
        <span className="md:hidden block text-[11.5px] text-white/55 truncate mt-0.5">
          {item.title}
        </span>
      </div>

      {/* Title — desktop column only */}
      <span className="hidden md:block text-white/60 truncate min-w-0">{item.title}</span>

      {/* Salary — desktop only, small inline chip */}
      <span className="hidden md:flex justify-self-start min-w-0">
        {item.salaryText ? (
          <span
            className="px-1.5 py-0.5 rounded text-[10.5px] font-medium bg-emerald-500/12 text-emerald-300 border border-emerald-500/20 truncate max-w-full tabular-nums"
            title={item.salaryText}
          >
            {item.salaryText}
          </span>
        ) : (
          <span className="text-[11px] text-white/30">—</span>
        )}
      </span>

      {/* Location — desktop only */}
      <span className="hidden md:flex text-[12px] text-white/50 truncate items-center gap-1 min-w-0">
        {item.location && <MapPin className="h-3 w-3 shrink-0 text-white/40" />}
        <span className="truncate">{item.location || "—"}</span>
      </span>

      {/* Season — desktop only */}
      <span className="hidden md:inline justify-self-start text-[10.5px] px-1.5 py-0.5 rounded bg-white/[0.05] text-white/55 truncate max-w-full">
        {primarySeason ? formatSeasonLabel(primarySeason) : "—"}
      </span>

      {/* Posted — visible on both viewports. >30d-old posts use a muted amber
          tone on the date itself (no separate "!" badge). */}
      {(() => {
        const stale = item.postedAt && isStale(item.postedAt);
        return (
          <span
            className={`text-[11px] tabular-nums flex items-center gap-1 truncate ${
              stale ? "text-amber-300/60" : "text-white/45"
            }`}
            title={stale ? "Posted >30 days ago — may be stale" : undefined}
          >
            {item.postedAt ? formatDate(item.postedAt) : "—"}
          </span>
        );
      })()}

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
          disabled={pending}
          aria-label={item.applied ? "Mark unapplied" : "Mark applied"}
          aria-pressed={item.applied}
          aria-busy={pending}
          className={`h-6 w-6 inline-flex items-center justify-center rounded transition-colors disabled:opacity-50 disabled:cursor-wait ${
            item.applied
              ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
              : "bg-transparent text-white/35 hover:text-white/70 hover:bg-white/[0.05]"
          }`}
          title={item.applied ? "Mark unapplied" : "Mark applied"}
        >
          {item.applied ? <Check className="h-3.5 w-3.5" /> : <span className="text-[14px] leading-none">○</span>}
        </button>
        {/* Hide / Unhide — visible on hover/focus on desktop, always on mobile
            so touch users can also dismiss postings (list is the default
            mobile view). Label and icon flip based on current state. */}
        <button
          onClick={onHide}
          disabled={pending}
          aria-label={item.hidden ? "Unhide posting" : "Hide posting"}
          aria-pressed={item.hidden ?? false}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-white/30 hover:text-white/80 hover:bg-white/[0.06] md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 transition-opacity disabled:opacity-50 disabled:cursor-wait"
          title={item.hidden ? "Unhide this posting" : "Hide this posting"}
        >
          {item.hidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
        </button>
        </div>
      </div>

      {/* Expanded description */}
      {expanded && (
        <div className="px-3 md:px-4 pt-2 pb-3 border-t border-white/[0.06] text-[12.5px] leading-relaxed text-white/70 space-y-2">
          {item.description ? (
            <p className="whitespace-pre-wrap line-clamp-[14]">{item.description}</p>
          ) : (
            <p className="text-white/45 italic">No description captured for this posting.</p>
          )}
          <button
            type="button"
            onClick={onToggleExpand}
            className="inline-flex items-center gap-1 text-[11px] text-white/50 hover:text-white/85 transition-colors"
          >
            <ChevronDown className="h-3 w-3 rotate-180" /> Collapse
          </button>
        </div>
      )}
    </div>
  );
}
