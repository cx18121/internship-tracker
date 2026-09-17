"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatSeasonLabel } from "@/lib/seasons";
import type { TierFilter } from "../_lib/types";
import { activeFilterCount, type Filters } from "../_lib/filters";
import { ROLE_TYPE_LABELS, DEGREE_LABELS } from "../_lib/labels";
import { METROS, METRO_LABELS, type Metro } from "@/lib/metros";

interface Props {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  onClearAll: () => void;
  // Derived from the loaded corpus.
  sources: string[] | null;
  seasonCounts: Array<[string, number]>;
  metroCounts: Partial<Record<Metro, number>>;
}

export const TIER_LABELS: Record<TierFilter, string> = {
  all: "All",
  "solid-or-better": "Solid+",
  "top-or-better": "Top+",
  elite: "Elite",
};

function toggleArr<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

// Every section can collapse; `collapsed` sets the initial state so the
// mobile sheet stays short. `activeCount` keeps a collapsed section honest.
function Section({
  label,
  children,
  trailing,
  collapsed = false,
  activeCount = 0,
}: {
  label: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  collapsed?: boolean;
  activeCount?: number;
}) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/40 hover:text-white/70 transition-colors"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
          {label}
          {!open && activeCount > 0 && (
            <span className="ml-1 px-1 rounded bg-white/10 text-white/70 normal-case tracking-normal tabular-nums">{activeCount}</span>
          )}
        </button>
        {open && trailing}
      </div>
      {open && children}
    </section>
  );
}

function Chip({
  active,
  dimmed,
  onClick,
  children,
  title,
}: {
  active: boolean;
  /** When true, render in the muted "not present in current corpus" style.
   *  Same UX cue as the unknown-keyword treatment elsewhere in the rail. */
  dimmed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  const style = active
    ? "border-white/30 bg-white/10 text-white"
    : dimmed
      ? "border-white/[0.06] bg-transparent text-white/25 hover:border-white/15"
      : "border-white/10 bg-transparent text-white/55 hover:border-white/20 hover:bg-white/[0.04]";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${style}`}
    >
      {children}
    </button>
  );
}

export function FilterRail({ filters: f, onChange, onClearAll, sources, seasonCounts, metroCounts }: Props) {
  const count = activeFilterCount(f);

  return (
    <aside className="space-y-6 text-[13px]">
      <div className="flex items-baseline justify-between pb-1 border-b border-white/[0.06]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/50">
          Filters
          {count > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-white/10 text-white/70 normal-case tracking-normal">
              {count}
            </span>
          )}
        </h2>
        {count > 0 && (
          <button
            onClick={onClearAll}
            className="text-[11px] text-white/40 hover:text-white/70 transition-colors"
          >
            Clear all
          </button>
        )}
      </div>

      <Section label="Tier">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(TIER_LABELS) as TierFilter[]).map((t) => (
            <Chip key={t} active={f.tier === t} onClick={() => onChange({ tier: t })}>
              {TIER_LABELS[t]}
            </Chip>
          ))}
        </div>
      </Section>

      <Section label="Type">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(ROLE_TYPE_LABELS) as Array<keyof typeof ROLE_TYPE_LABELS>).map((t) => (
            <Chip key={t} active={f.roleTypes.includes(t)} onClick={() => onChange({ roleTypes: toggleArr(f.roleTypes, t) })}>
              {ROLE_TYPE_LABELS[t]}
            </Chip>
          ))}
        </div>
      </Section>

      <Section label="Degree" collapsed activeCount={f.degrees.length}>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(DEGREE_LABELS) as Array<keyof typeof DEGREE_LABELS>).map((d) => (
            <Chip key={d} active={f.degrees.includes(d)} onClick={() => onChange({ degrees: toggleArr(f.degrees, d) })}>
              {DEGREE_LABELS[d]}
            </Chip>
          ))}
        </div>
      </Section>

      <Section
        label="Min Score"
        trailing={
          <span className="text-[11px] tabular-nums text-white/70">{f.minScore}</span>
        }
      >
        <input
          type="range"
          min={0}
          max={100}
          value={f.minScore}
          onChange={(e) => onChange({ minScore: Number(e.target.value) })}
          className="w-full accent-white/70 h-1"
        />
      </Section>

      <Section label="Season">
        <div className="flex flex-wrap gap-1.5">
          {seasonCounts.length === 0 ? (
            <span className="text-[11px] text-white/45">None detected</span>
          ) : (
            seasonCounts.map(([token, n]) => (
              <Chip
                key={token}
                active={f.seasons.includes(token)}
                onClick={() => onChange({ seasons: toggleArr(f.seasons, token) })}
              >
                {formatSeasonLabel(token)}{" "}
                <span className="text-white/45 tabular-nums">{n}</span>
              </Chip>
            ))
          )}
        </div>
      </Section>

      <Section label="Source" collapsed activeCount={f.sources.length}>
        <div className="flex flex-wrap gap-1.5">
          {sources === null ? (
            Array.from({ length: 4 }).map((_, i) => (
              <span
                key={i}
                className="px-2 py-1 rounded-md text-[11px] border bg-white/5 border-white/10 text-transparent animate-pulse w-14"
              >
                &nbsp;
              </span>
            ))
          ) : sources.length === 0 ? (
            <span className="text-[11px] text-white/45">No sources yet</span>
          ) : (
            sources.map((s) => (
              <Chip
                key={s}
                active={f.sources.includes(s)}
                onClick={() => onChange({ sources: toggleArr(f.sources, s) })}
              >
                {s}
              </Chip>
            ))
          )}
        </div>
      </Section>

      <Section label="Location">
        <div className="flex flex-wrap gap-1.5 mb-2">
          {METROS.map((m) => (
            <Chip
              key={m}
              active={f.metros.includes(m)}
              dimmed={!metroCounts[m]}
              onClick={() => onChange({ metros: toggleArr(f.metros, m) })}
            >
              {METRO_LABELS[m]}{" "}
              <span className="text-white/45 tabular-nums">{metroCounts[m] ?? 0}</span>
            </Chip>
          ))}
        </div>
        <Input
          placeholder="City or state…"
          value={f.locationText}
          onChange={(e) => onChange({ locationText: e.target.value })}
          className="h-7 text-[12px] bg-white/[0.04] border-white/10"
        />
      </Section>

    </aside>
  );
}
