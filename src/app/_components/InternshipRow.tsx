"use client";

import { memo } from "react";
import { ExternalLink, MapPin } from "lucide-react";
import type { Internship } from "../_lib/types";
import {
  SCORE_BADGE,
  SCORE_BADGE_FALLBACK,
  SOURCE_DOT,
  SOURCE_DOT_FALLBACK,
} from "../_lib/constants";
import { formatDate, isStale, timeAgo } from "../_lib/format";
import { formatSeasonLabel } from "@/lib/seasons";

// Shared grid template — used by the row AND the header in InternshipList
// so columns align across every row.
//
// Mobile (< md): 4 cols — Score · Company+title (stacked) · Posted · Apply.
// Desktop (md+): the full 9-col operator template (Score · Company · Title
//   · Salary · Location · Season · Posted · Verified · Actions).
export const LIST_GRID_COLS =
  "grid-cols-[3.5rem_minmax(0,1fr)_4.5rem_4.5rem] md:grid-cols-[4rem_minmax(0,11rem)_minmax(0,1fr)_minmax(0,8rem)_minmax(0,9rem)_minmax(0,6rem)_minmax(0,5rem)_minmax(0,5rem)_minmax(0,5.5rem)]";

interface Props {
  item: Internship;
}

function InternshipRowImpl({ item }: Props) {
  const primarySeason = (item.season ?? [])[0];
  const gradOnly = !!item.degrees && item.degrees.length > 0 && !item.degrees.includes("bs");

  return (
    <div className="rounded border border-white/[0.05] bg-white/[0.015] hover:border-white/[0.1] transition-colors">
      <div
        className={`group grid ${LIST_GRID_COLS} items-center gap-2 md:gap-3 px-2.5 md:px-3 py-2 hover:bg-white/[0.025] transition-colors text-[13px] rounded`}
      >
      {/* Score */}
      <span
        className={`justify-self-start text-[10.5px] font-semibold tabular-nums px-1.5 py-0.5 rounded ${
          (item.scoreLabel ? SCORE_BADGE[item.scoreLabel] : undefined) ?? SCORE_BADGE_FALLBACK
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
          {item.companyTier === "hot" && (
            <span className="shrink-0 text-[9.5px] px-1 rounded bg-orange-500/15 text-orange-300 border border-orange-500/25" title="High-growth startup">
              hot
            </span>
          )}
        </span>
        {/* Title appears under company on mobile only; desktop has its own column */}
        <span className="md:hidden block text-[11.5px] text-white/55 truncate mt-0.5">
          {item.title}
        </span>
      </div>

      {/* Title — desktop column only */}
      <span className="hidden md:block text-white/60 truncate min-w-0">{item.title}</span>

      {/* Salary — desktop only, small inline chip */}
      <span className="hidden md:flex overflow-hidden min-w-0">
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

      {/* Season — desktop only. Graduate-only roles carry a degree tag. */}
      <span className="hidden md:flex items-center gap-1 min-w-0">
        <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-white/[0.05] text-white/55 truncate">
          {primarySeason ? formatSeasonLabel(primarySeason) : "—"}
        </span>
        {gradOnly && (
          <span className="shrink-0 text-[9.5px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/25" title={`Eligible: ${item.degrees!.join(", ").toUpperCase()}`}>
            {item.degrees!.map((d) => d.toUpperCase()).join("/")}
          </span>
        )}
      </span>

      {/* Posted — visible on both viewports. >30d-old posts use a muted amber
          tone on the date itself (no separate "!" badge). */}
      {(() => {
        const stale = item.postedAt && isStale(item.postedAt);
        return (
          <span
            className={`text-[11px] tabular-nums flex items-center gap-1 truncate ${
              stale ? "text-amber-300/60" : "text-white/55"
            }`}
            title={stale ? "Posted >30 days ago — may be stale" : undefined}
          >
            {item.postedAt ? formatDate(item.postedAt) : "—"}
          </span>
        );
      })()}

      {/* Verified — last time any of our pollers re-confirmed the role is
          still listed. Desktop-only; mobile already shows Posted in the
          tight 4-col layout. */}
      <span
        className="hidden md:flex text-[11px] tabular-nums text-white/55 truncate"
        title={
          item.seenAt
            ? `Last confirmed by poller ${timeAgo(item.seenAt)}`
            : undefined
        }
      >
        {item.seenAt ? formatDate(item.seenAt) : "—"}
      </span>

      {/* Actions */}
      <div className="flex items-center gap-2 md:gap-1 justify-self-end">
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Apply to ${item.title} at ${item.company}`}
          className="inline-flex items-center gap-1 h-8 md:h-6 px-2 rounded text-[11px] font-medium bg-white/10 hover:bg-white/20 text-white/85 transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          <span className="hidden md:inline">Apply</span>
        </a>
        </div>
      </div>

    </div>
  );
}

export const InternshipRow = memo(InternshipRowImpl);
