"use client";

import { X } from "lucide-react";
import { formatSeasonLabel } from "@/lib/seasons";
import type { TierFilter, DateWindow } from "../_lib/types";
import { DATE_WINDOWS } from "../_lib/constants";

/**
 * Renders a removable pill for each active filter so the user can see and
 * undo any single filter without bouncing to the sidebar. No-op when there
 * are no active filters.
 */
interface Props {
  searchText: string;
  selectedSources: string[];
  tierFilter: TierFilter;
  selectedSeasons: string[];
  minScore: number;
  selectedLocations: string[];
  locationText: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  dateWindow: DateWindow;

  setSearchText: (s: string) => void;
  setSelectedSources: (fn: (prev: string[]) => string[]) => void;
  setTierFilter: (t: TierFilter) => void;
  setSelectedSeasons: (fn: (prev: string[]) => string[]) => void;
  setMinScore: (n: number) => void;
  setSelectedLocations: (fn: (prev: string[]) => string[]) => void;
  setLocationText: (s: string) => void;
  setIncludeKeywords: (fn: (prev: string[]) => string[]) => void;
  setExcludeKeywords: (fn: (prev: string[]) => string[]) => void;
  setDateWindow: (d: DateWindow) => void;
  onClearAll: () => void;
}

function Pill({
  label,
  onClear,
  tone = "neutral",
}: {
  label: React.ReactNode;
  onClear: () => void;
  tone?: "neutral" | "danger";
}) {
  const tint =
    tone === "danger"
      ? "bg-red-500/10 border-red-500/25 text-red-300 hover:bg-red-500/15"
      : "bg-white/[0.06] border-white/15 text-white/75 hover:bg-white/[0.10]";
  return (
    <span
      className={`inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] border transition-colors ${tint}`}
    >
      <span className="whitespace-nowrap">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove filter ${typeof label === "string" ? label : ""}`}
        className="opacity-60 hover:opacity-100 transition-opacity"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

export function ActiveFilterChips(props: Props) {
  const {
    searchText,
    selectedSources,
    tierFilter,
    selectedSeasons,
    minScore,
    selectedLocations,
    locationText,
    includeKeywords,
    excludeKeywords,
    dateWindow,
    setSearchText,
    setSelectedSources,
    setTierFilter,
    setSelectedSeasons,
    setMinScore,
    setSelectedLocations,
    setLocationText,
    setIncludeKeywords,
    setExcludeKeywords,
    setDateWindow,
    onClearAll,
  } = props;

  const windowLabel = DATE_WINDOWS.find((d) => d.value === dateWindow)?.label;

  const chips: React.ReactNode[] = [];

  if (searchText)
    chips.push(
      <Pill key="search" label={<>Search: <span className="text-white">{searchText}</span></>} onClear={() => setSearchText("")} />,
    );

  if (tierFilter !== "all")
    chips.push(
      <Pill
        key="tier"
        label={`Tier: ${tierFilter === "elite" ? "Elite" : "Top+"}`}
        onClear={() => setTierFilter("all")}
      />,
    );

  if (minScore > 0)
    chips.push(<Pill key="minScore" label={`Min ${minScore}`} onClear={() => setMinScore(0)} />);

  if (dateWindow !== "all" && windowLabel)
    chips.push(
      <Pill key="when" label={`Last ${windowLabel}`} onClear={() => setDateWindow("all")} />,
    );

  for (const s of selectedSources)
    chips.push(
      <Pill key={`src-${s}`} label={s} onClear={() => setSelectedSources((prev) => prev.filter((x) => x !== s))} />,
    );

  for (const t of selectedSeasons)
    chips.push(
      <Pill
        key={`season-${t}`}
        label={formatSeasonLabel(t)}
        onClear={() => setSelectedSeasons((prev) => prev.filter((x) => x !== t))}
      />,
    );

  for (const l of selectedLocations)
    chips.push(
      <Pill key={`loc-${l}`} label={l} onClear={() => setSelectedLocations((prev) => prev.filter((x) => x !== l))} />,
    );

  if (locationText)
    chips.push(
      <Pill key="loc-text" label={`Location: ${locationText}`} onClear={() => setLocationText("")} />,
    );

  for (const k of includeKeywords)
    chips.push(
      <Pill
        key={`kw-${k}`}
        label={`+${k}`}
        onClear={() => setIncludeKeywords((prev) => prev.filter((x) => x !== k))}
      />,
    );

  for (const k of excludeKeywords)
    chips.push(
      <Pill
        key={`xkw-${k}`}
        label={`−${k}`}
        tone="danger"
        onClear={() => setExcludeKeywords((prev) => prev.filter((x) => x !== k))}
      />,
    );

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-[11px] text-white/50 hover:text-white/85 underline underline-offset-4 ml-1 transition-colors"
        >
          clear all
        </button>
      )}
    </div>
  );
}
