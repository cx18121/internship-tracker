"use client";

import { useState } from "react";
import { MapPin, ExternalLink, StickyNote, Check, Eye, EyeOff, ChevronDown } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { Internship } from "../_lib/types";
import {
  SCORE_BADGE,
  SCORE_BADGE_FALLBACK,
  SOURCE_DOT,
  SOURCE_DOT_FALLBACK,
} from "../_lib/constants";
import { timeAgo, formatDate, isStale } from "../_lib/format";

interface Props {
  item: Internship;
  appliedDate: string | null;
  notes: string;
  pending?: boolean;
  onNotesChange: (note: string) => void;
  onToggleApplied: () => void;
  onHide: () => void;
}

export function InternshipCard({
  item,
  appliedDate,
  notes,
  pending = false,
  onNotesChange,
  onToggleApplied,
  onHide,
}: Props) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const uniqueKws = Array.from(new Set(item.matchedKeywords ?? []));

  return (
    <article
      className={`group relative flex flex-col gap-2.5 p-3.5 rounded-lg border bg-[oklch(0.18_0.005_260)] transition-colors ${
        item.applied
          ? "border-white/[0.06] opacity-55 hover:opacity-100"
          : "border-white/10 hover:border-white/20"
      }`}
    >
      {/* Hide / Unhide — appears on hover, top-right corner. Label and icon
          flip based on current state. */}
      <button
        onClick={onHide}
        disabled={pending}
        aria-label={item.hidden ? "Unhide posting" : "Hide posting"}
        aria-pressed={item.hidden ?? false}
        title={item.hidden ? "Unhide this posting" : "Hide this posting"}
        className="absolute top-2.5 right-2.5 h-6 w-6 inline-flex items-center justify-center rounded text-white/35 hover:text-white/80 hover:bg-white/[0.06] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-50 disabled:cursor-wait"
      >
        {item.hidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      </button>
      {/* Header row: identity left, score+timing right */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${SOURCE_DOT[item.source] ?? SOURCE_DOT_FALLBACK}`}
              aria-hidden="true"
              title={`Source: ${item.source}`}
            />
            <span className="sr-only">Source: {item.source}.</span>
            <h3 className="font-semibold text-[13.5px] text-white truncate leading-tight">
              {item.company}
            </h3>
          </div>
          <p className="text-[12.5px] text-white/60 mt-1 leading-snug line-clamp-2">
            {item.title}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 tabular-nums">
          {item.scoreLabel && (
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                SCORE_BADGE[item.scoreLabel] ?? SCORE_BADGE_FALLBACK
              }`}
            >
              {item.scoreLabel}
              {item.score != null ? ` ${item.score}` : ""}
            </span>
          )}
          {item.seenAt && (
            <span className="text-[10px] text-white/45">{timeAgo(item.seenAt)}</span>
          )}
        </div>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-white/50">
        {item.location && (
          <span className="flex items-center gap-1 min-w-0 max-w-full">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{item.location}</span>
          </span>
        )}
        {item.salaryText && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/12 text-emerald-300 border border-emerald-500/20">
            {item.salaryText}
          </span>
        )}
        {item.postedAt && (
          <span className="flex items-center gap-1.5 text-white/45">
            {formatDate(item.postedAt)}
            {isStale(item.postedAt) && (
              <span className="px-1 py-px rounded text-[9px] font-medium bg-amber-500/12 text-amber-300 border border-amber-500/25">
                stale
              </span>
            )}
          </span>
        )}
      </div>

      {/* Matched keywords — quiet chips */}
      {uniqueKws.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {uniqueKws.slice(0, 6).map((kw) => (
            <span
              key={kw}
              className="px-1.5 py-0.5 rounded bg-white/[0.04] text-[10.5px] text-white/55 border border-white/[0.04]"
            >
              {kw}
            </span>
          ))}
          {uniqueKws.length > 6 && (
            <span className="text-[10px] text-white/45 self-center">
              +{uniqueKws.length - 6}
            </span>
          )}
        </div>
      )}

      {/* Action row */}
      <div className="flex items-center gap-2 pt-0.5">
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] font-medium bg-white text-[oklch(0.13_0.005_260)] hover:bg-white/90 transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          Apply
        </a>
        <button
          onClick={onToggleApplied}
          disabled={pending}
          aria-pressed={item.applied}
          aria-busy={pending}
          className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11.5px] border transition-colors disabled:opacity-50 disabled:cursor-wait ${
            item.applied
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
              : "border-white/15 bg-transparent text-white/55 hover:bg-white/[0.04] hover:text-white/80"
          }`}
        >
          {item.applied ? (
            <>
              <Check className="h-3 w-3" /> Applied
            </>
          ) : (
            "Mark applied"
          )}
        </button>
        {appliedDate && item.applied && (
          <span className="text-[10px] text-white/45 tabular-nums">{formatDate(appliedDate)}</span>
        )}
        <button
          onClick={() => setNotesOpen((v) => !v)}
          aria-pressed={notesOpen}
          aria-label={notes ? "Edit note" : "Add note"}
          className={`ml-auto h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors ${
            notes
              ? "text-white/70 bg-white/[0.04] hover:bg-white/[0.08]"
              : "text-white/35 hover:text-white/70 hover:bg-white/[0.04]"
          }`}
          title={notes ? "Edit note" : "Add note"}
        >
          <StickyNote className="h-3.5 w-3.5" />
        </button>
      </div>

      {notesOpen && (
        <Textarea
          placeholder="Notes…"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          className="text-[12px] bg-white/[0.04] border-white/10 text-white/80 placeholder:text-white/30 resize-none h-16"
        />
      )}

      {/* Description expand — only shown when the posting actually carries one */}
      {item.description && (
        <div className="border-t border-white/[0.06] pt-2 -mx-3.5 -mb-3.5 px-3.5 pb-3">
          <button
            type="button"
            onClick={() => setDescOpen((v) => !v)}
            aria-expanded={descOpen}
            className="inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white/80 transition-colors"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${descOpen ? "rotate-180" : ""}`}
            />
            {descOpen ? "Hide description" : "Show description"}
          </button>
          {descOpen && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-white/70 whitespace-pre-wrap line-clamp-[14]">
              {item.description}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
