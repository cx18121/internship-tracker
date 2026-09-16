"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { KeywordChips } from "./KeywordChips";
import { LOCATION_PRESETS } from "../_lib/constants";
import { formatSeasonLabel } from "@/lib/seasons";
import { ELITE_COUNT, TOP_COUNT, SOLID_COUNT } from "@/lib/tiers";
import { ROLE_SPECIALIZATIONS, type RoleId } from "@/lib/role-taxonomy";
import type { TierFilter } from "../_lib/types";
import { activeFilterCount, type Filters } from "../_lib/filters";

interface Props {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  onClearAll: () => void;
  // Derived from the loaded corpus.
  sources: string[] | null;
  seasonCounts: Array<[string, number]>;
  /** Keywords present on at least one loaded posting; others are dimmed. */
  knownKeywords: Set<string>;
  /** Roles matching at least one loaded posting; others are dimmed. */
  availableRoles: Set<RoleId>;
}

export const TIER_LABELS: Record<TierFilter, string> = {
  all: "All",
  "solid-or-better": `Top ${ELITE_COUNT + TOP_COUNT + SOLID_COUNT}`,
  "top-or-better": `Top ${ELITE_COUNT + TOP_COUNT}`,
  elite: `Top ${ELITE_COUNT}`,
};

function toggleArr<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function Section({
  label,
  children,
  trailing,
}: {
  label: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/40">
          {label}
        </h3>
        {trailing}
      </div>
      {children}
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

export function FilterRail({ filters: f, onChange, onClearAll, sources, seasonCounts, knownKeywords, availableRoles }: Props) {
  const count = activeFilterCount(f);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

      <Section label="Role">
        <div className="flex flex-wrap gap-1.5">
          {ROLE_SPECIALIZATIONS.map((r) => (
            <Chip
              key={r.id}
              active={f.roles.includes(r.id)}
              dimmed={!availableRoles.has(r.id)}
              onClick={() => onChange({ roles: toggleArr(f.roles, r.id) })}
              title={!availableRoles.has(r.id) ? "No postings match this role in the current corpus" : undefined}
            >
              {r.label}
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

      <Section label="Source">
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
          {LOCATION_PRESETS.map((l) => (
            <Chip
              key={l}
              active={f.locations.includes(l)}
              onClick={() => onChange({ locations: toggleArr(f.locations, l) })}
            >
              {l}
            </Chip>
          ))}
        </div>
        <Input
          placeholder="Other location…"
          value={f.locationText}
          onChange={(e) => onChange({ locationText: e.target.value })}
          className="h-7 text-[12px] bg-white/[0.04] border-white/10"
        />
      </Section>

      <div className="border-t border-white/[0.06] pt-4">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/40 hover:text-white/70 transition-colors"
          aria-expanded={advancedOpen}
        >
          <ChevronRight
            className={`h-3 w-3 transition-transform ${advancedOpen ? "rotate-90" : ""}`}
          />
          Advanced
        </button>

        {advancedOpen && (
          <div className="space-y-5 mt-4">
            <Section label="Include keywords">
              <KeywordChips
                values={f.include}
                onValuesChange={(v) => onChange({ include: v })}
                placeholder="e.g. React"
                knownKeywords={knownKeywords}
                tone="include"
              />
            </Section>

            <Section label="Exclude keywords">
              <KeywordChips
                values={f.exclude}
                onValuesChange={(v) => onChange({ exclude: v })}
                placeholder="e.g. PhD"
                knownKeywords={knownKeywords}
                tone="exclude"
              />
            </Section>
          </div>
        )}
      </div>
    </aside>
  );
}
