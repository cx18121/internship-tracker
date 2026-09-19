"use client";

import { X } from "lucide-react";
import { formatSeasonLabel } from "@/lib/seasons";
import { DATE_WINDOWS } from "../_lib/constants";
import type { Filters } from "../_lib/filters";
import { ROLE_TYPE_LABELS, DEGREE_LABELS, TIER_LABELS } from "../_lib/labels";
import { METRO_LABELS } from "@/lib/metros";

/**
 * Renders a removable pill for each active filter so the user can see and
 * undo any single filter without bouncing to the sidebar. No-op when there
 * are no active filters.
 */
interface Props {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
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

export function ActiveFilterChips({ filters: f, onChange, onClearAll }: Props) {
  const windowLabel = DATE_WINDOWS.find((d) => d.value === f.when)?.label;
  const without = <T,>(list: T[], v: T) => list.filter((x) => x !== v);

  const chips: React.ReactNode[] = [];

  if (f.q)
    chips.push(
      <Pill key="search" label={<>Search: <span className="text-white">{f.q}</span></>} onClear={() => onChange({ q: "" })} />,
    );
  for (const t of f.tiers)
    chips.push(<Pill key={`tier-${t}`} label={TIER_LABELS[t]} onClear={() => onChange({ tiers: without(f.tiers, t) })} />);
  if (f.minScore > 0)
    chips.push(<Pill key="minScore" label={`Min ${f.minScore}`} onClear={() => onChange({ minScore: 0 })} />);
  if (f.when !== "all" && windowLabel)
    chips.push(<Pill key="when" label={`Last ${windowLabel}`} onClear={() => onChange({ when: "all" })} />);
  for (const s of f.sources)
    chips.push(<Pill key={`src-${s}`} label={s} onClear={() => onChange({ sources: without(f.sources, s) })} />);
  for (const t of f.seasons)
    chips.push(<Pill key={`season-${t}`} label={formatSeasonLabel(t)} onClear={() => onChange({ seasons: without(f.seasons, t) })} />);
  for (const t of f.roleTypes)
    chips.push(<Pill key={`type-${t}`} label={ROLE_TYPE_LABELS[t] ?? t} onClear={() => onChange({ roleTypes: without(f.roleTypes, t) })} />);
  for (const d of f.degrees)
    chips.push(<Pill key={`deg-${d}`} label={DEGREE_LABELS[d]} onClear={() => onChange({ degrees: without(f.degrees, d) })} />);
  for (const m of f.metros)
    chips.push(<Pill key={`metro-${m}`} label={METRO_LABELS[m]} onClear={() => onChange({ metros: without(f.metros, m) })} />);
  if (f.locationText)
    chips.push(<Pill key="loc-text" label={`Location: ${f.locationText}`} onClear={() => onChange({ locationText: "" })} />);
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
