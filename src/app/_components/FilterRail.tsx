"use client";

import { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LOCATION_PRESETS } from "../_lib/constants";
import { formatSeasonLabel } from "@/lib/seasons";
import { ELITE_COUNT, TOP_COUNT, SOLID_COUNT } from "@/lib/tiers";
import { ROLE_SPECIALIZATIONS, type RoleId } from "@/lib/role-taxonomy";
import type { TierFilter } from "../_lib/types";

interface Props {
  // data
  dynamicSources: string[] | null;
  dynamicSeasons: Array<[string, number]>;
  // state
  selectedSources: string[];
  tierFilter: TierFilter;
  selectedSeasons: string[];
  selectedRoles: RoleId[];
  minScore: number;
  selectedLocations: string[];
  locationText: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  // Every keyword present on at least one loaded internship. Keyword chips
  // not in this set are dimmed with a "not found in any posting" tooltip —
  // the include/exclude filter matches against the scorer's matchedKeywords,
  // not free text, so an unknown keyword silently zeroes out the result list.
  knownKeywords: Set<string>;
  // Role IDs that match at least one posting in the loaded corpus. Roles
  // outside this set get dimmed the same way unknown keyword chips do.
  availableRoles: Set<RoleId>;
  // setters
  setSelectedSources: (fn: (prev: string[]) => string[]) => void;
  setTierFilter: (t: TierFilter) => void;
  setSelectedSeasons: (fn: (prev: string[]) => string[]) => void;
  setSelectedRoles: (fn: (prev: RoleId[]) => RoleId[]) => void;
  setMinScore: (n: number) => void;
  setSelectedLocations: (fn: (prev: string[]) => string[]) => void;
  setLocationText: (s: string) => void;
  setIncludeKeywords: (fn: (prev: string[]) => string[]) => void;
  setExcludeKeywords: (fn: (prev: string[]) => string[]) => void;
  // misc
  activeFilterCount: number;
  onClearAll: () => void;
}

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

export function FilterRail(props: Props) {
  const {
    dynamicSources,
    dynamicSeasons,
    selectedSources,
    tierFilter,
    selectedSeasons,
    selectedRoles,
    minScore,
    selectedLocations,
    locationText,
    includeKeywords,
    excludeKeywords,
    knownKeywords,
    availableRoles,
    setSelectedSources,
    setTierFilter,
    setSelectedSeasons,
    setSelectedRoles,
    setMinScore,
    setSelectedLocations,
    setLocationText,
    setIncludeKeywords,
    setExcludeKeywords,
    activeFilterCount,
    onClearAll,
  } = props;

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [kwIncludeInput, setKwIncludeInput] = useState("");
  const [kwExcludeInput, setKwExcludeInput] = useState("");

  function addKw(type: "include" | "exclude", val: string): void {
    const trimmed = val.trim();
    if (!trimmed) return;
    if (type === "include") {
      setIncludeKeywords((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
      setKwIncludeInput("");
    } else {
      setExcludeKeywords((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
      setKwExcludeInput("");
    }
  }

  return (
    <aside className="space-y-6 text-[13px]">
      <div className="flex items-baseline justify-between pb-1 border-b border-white/[0.06]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/50">
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-white/10 text-white/70 normal-case tracking-normal">
              {activeFilterCount}
            </span>
          )}
        </h2>
        {activeFilterCount > 0 && (
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
          {(["all", "solid-or-better", "top-or-better", "elite"] as TierFilter[]).map((t) => (
            <Chip key={t} active={tierFilter === t} onClick={() => setTierFilter(t)}>
              {t === "all"
                ? "All"
                : t === "elite"
                  ? `Top ${ELITE_COUNT}`
                  : t === "top-or-better"
                    ? `Top ${ELITE_COUNT + TOP_COUNT}`
                    : `Top ${ELITE_COUNT + TOP_COUNT + SOLID_COUNT}`}
            </Chip>
          ))}
        </div>
      </Section>

      <Section label="Role">
        <div className="flex flex-wrap gap-1.5">
          {ROLE_SPECIALIZATIONS.map((r) => (
            <Chip
              key={r.id}
              active={selectedRoles.includes(r.id)}
              dimmed={!availableRoles.has(r.id)}
              onClick={() => setSelectedRoles((prev) => toggleArr(prev, r.id))}
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
          <span className="text-[11px] tabular-nums text-white/70">{minScore}</span>
        }
      >
        <input
          type="range"
          min={0}
          max={100}
          value={minScore}
          onChange={(e) => setMinScore(Number(e.target.value))}
          className="w-full accent-white/70 h-1"
        />
      </Section>

      <Section label="Season">
        <div className="flex flex-wrap gap-1.5">
          {dynamicSeasons.length === 0 ? (
            <span className="text-[11px] text-white/45">None detected</span>
          ) : (
            dynamicSeasons.map(([token, count]) => (
              <Chip
                key={token}
                active={selectedSeasons.includes(token)}
                onClick={() => setSelectedSeasons((prev) => toggleArr(prev, token))}
              >
                {formatSeasonLabel(token)}{" "}
                <span className="text-white/45 tabular-nums">{count}</span>
              </Chip>
            ))
          )}
        </div>
      </Section>

      <Section label="Source">
        <div className="flex flex-wrap gap-1.5">
          {dynamicSources === null ? (
            Array.from({ length: 4 }).map((_, i) => (
              <span
                key={i}
                className="px-2 py-1 rounded-md text-[11px] border bg-white/5 border-white/10 text-transparent animate-pulse w-14"
              >
                &nbsp;
              </span>
            ))
          ) : dynamicSources.length === 0 ? (
            <span className="text-[11px] text-white/45">No sources yet</span>
          ) : (
            dynamicSources.map((s) => (
              <Chip
                key={s}
                active={selectedSources.includes(s)}
                onClick={() => setSelectedSources((prev) => toggleArr(prev, s))}
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
              active={selectedLocations.includes(l)}
              onClick={() => setSelectedLocations((prev) => toggleArr(prev, l))}
            >
              {l}
            </Chip>
          ))}
        </div>
        <Input
          placeholder="Other location…"
          value={locationText}
          onChange={(e) => setLocationText(e.target.value)}
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
              <div className="flex gap-1.5">
                <Input
                  placeholder="e.g. React"
                  value={kwIncludeInput}
                  onChange={(e) => setKwIncludeInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addKw("include", kwIncludeInput)}
                  className="h-7 text-[12px] bg-white/[0.04] border-white/10"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px] border-white/10 bg-white/[0.04]"
                  onClick={() => addKw("include", kwIncludeInput)}
                >
                  Add
                </Button>
              </div>
              {includeKeywords.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {includeKeywords.map((k) => {
                    const unknown = !knownKeywords.has(k.toLowerCase());
                    return (
                      <span
                        key={k}
                        title={unknown ? "Not in any posting's tags — filter will return 0 results" : undefined}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
                          unknown
                            ? "bg-amber-500/10 text-amber-400/80 line-through decoration-amber-400/50"
                            : "bg-white/10 text-white/70"
                        }`}
                      >
                        {k}
                        <button onClick={() => setIncludeKeywords((p) => p.filter((x) => x !== k))}>
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </Section>

            <Section label="Exclude keywords">
              <div className="flex gap-1.5">
                <Input
                  placeholder="e.g. PhD"
                  value={kwExcludeInput}
                  onChange={(e) => setKwExcludeInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addKw("exclude", kwExcludeInput)}
                  className="h-7 text-[12px] bg-white/[0.04] border-white/10"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px] border-white/10 bg-white/[0.04]"
                  onClick={() => addKw("exclude", kwExcludeInput)}
                >
                  Add
                </Button>
              </div>
              {excludeKeywords.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {excludeKeywords.map((k) => {
                    const unknown = !knownKeywords.has(k.toLowerCase());
                    return (
                      <span
                        key={k}
                        title={unknown ? "Not in any posting's tags — has no effect on results" : undefined}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
                          unknown
                            ? "bg-white/[0.04] text-white/30 line-through decoration-white/20"
                            : "bg-red-500/10 text-red-400"
                        }`}
                      >
                        {k}
                        <button onClick={() => setExcludeKeywords((p) => p.filter((x) => x !== k))}>
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </Section>
          </div>
        )}
      </div>
    </aside>
  );
}
