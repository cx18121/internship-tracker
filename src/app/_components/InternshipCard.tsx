"use client";

import { useState } from "react";
import { MapPin, ExternalLink, StickyNote } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Internship } from "../_lib/types";
import {
  SCORE_BADGE,
  SCORE_BADGE_FALLBACK,
  SOURCE_BADGE,
  SOURCE_BADGE_FALLBACK,
} from "../_lib/constants";
import { timeAgo, formatDate, isStale } from "../_lib/format";

interface Props {
  item: Internship;
  appliedDate: string | null;
  notes: string;
  onNotesChange: (note: string) => void;
  onToggleApplied: () => void;
}

export function InternshipCard({
  item,
  appliedDate,
  notes,
  onNotesChange,
  onToggleApplied,
}: Props) {
  const [notesOpen, setNotesOpen] = useState(false);

  return (
    <Card
      className={`relative flex flex-col gap-3 p-4 border-white/10 bg-white/[0.03] transition-opacity ${
        item.applied ? "opacity-50" : ""
      }`}
    >
      {item.applied && (
        <span className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-widest text-white/30 border border-white/20 px-2 py-0.5 rounded rotate-[-6deg]">
          Applied
        </span>
      )}

      <div className="flex items-start justify-between gap-2 pr-16">
        <div>
          <p className="font-semibold text-sm text-white leading-tight">{item.company}</p>
          <p className="text-xs text-white/60 mt-0.5">{item.title}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {item.seenAt && (
            <span className="text-[10px] font-medium text-white/40 px-1.5 py-0.5">
              {timeAgo(item.seenAt)}
            </span>
          )}
          {item.scoreLabel && (
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                SCORE_BADGE[item.scoreLabel] ?? SCORE_BADGE_FALLBACK
              }`}
            >
              {item.scoreLabel}
              {item.score != null ? ` · ${item.score}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/40">
        {item.location && (
          <span className="flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {item.location}
          </span>
        )}
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] ${
            SOURCE_BADGE[item.source] ?? SOURCE_BADGE_FALLBACK
          }`}
        >
          {item.source}
        </span>
        {item.salaryText && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
            {item.salaryText}
          </span>
        )}
        {item.postedAt && (
          <span className="flex items-center gap-1.5 text-white/30">
            {formatDate(item.postedAt)}
            {isStale(item.postedAt) && (
              <span className="px-1 py-0.5 rounded text-[9px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                Stale?
              </span>
            )}
          </span>
        )}
      </div>

      {(item.matchedKeywords ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(item.matchedKeywords ?? []).slice(0, 6).map((kw) => (
            <span
              key={kw}
              className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[10px] text-white/50"
            >
              {kw}
            </span>
          ))}
          {(item.matchedKeywords ?? []).length > 6 && (
            <span className="text-[10px] text-white/30">
              +{(item.matchedKeywords ?? []).length - 6}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "h-7 px-3 text-xs border-white/10 bg-white/5 hover:bg-white/10"
          )}
        >
          <ExternalLink className="h-3 w-3 mr-1" />
          Apply
        </a>
        <button
          onClick={onToggleApplied}
          className="text-xs text-white/30 hover:text-white/60 transition-colors"
        >
          {item.applied ? "Mark unapplied" : "Mark applied"}
        </button>
        {appliedDate && (
          <span className="text-[10px] text-white/30">
            Applied {formatDate(appliedDate)}
          </span>
        )}
        <button
          onClick={() => setNotesOpen((v) => !v)}
          className={`ml-auto text-white/30 hover:text-white/60 transition-colors ${
            notes ? "text-white/50" : ""
          }`}
          title="Notes"
        >
          <StickyNote className="h-3.5 w-3.5" />
        </button>
      </div>

      {notesOpen && (
        <Textarea
          placeholder="Add notes…"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          className="text-xs bg-white/5 border-white/10 text-white/70 placeholder:text-white/20 resize-none h-16"
        />
      )}
    </Card>
  );
}
