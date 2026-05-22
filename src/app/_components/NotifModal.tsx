"use client";

import { useState } from "react";
import { Bell, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ELITE_COUNT, TOP_COUNT } from "@/lib/tiers";
import { formatSeasonLabel } from "@/lib/seasons";
import type { TierFilter } from "../_lib/types";

interface SeasonOption {
  token: string;
  count: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Score + tier + seasons (existing)
  minScore: number;
  onMinScoreChange: (n: number) => void;
  tierFilter: TierFilter;
  onTierFilterChange: (t: TierFilter) => void;
  selectedSeasons: string[];
  onSeasonsToggle: (token: string) => void;
  seasonOptions: SeasonOption[];
  // Source-down alerts (existing toggle)
  sourceDownAlerts: boolean;
  onSourceDownAlertsChange: (b: boolean) => void;
  // Source blocklist
  dynamicSources: string[] | null;
  excludedSources: string[];
  onExcludedSourcesChange: (fn: (prev: string[]) => string[]) => void;
  // Location: non-US suppression
  excludeNonUS: boolean;
  onExcludeNonUSChange: (b: boolean) => void;
  // Keywords (matchedKeywords scorer-tag matching, same as FilterRail)
  includeKeywords: string[];
  excludeKeywords: string[];
  knownKeywords: Set<string>;
  onIncludeKeywordsChange: (fn: (prev: string[]) => string[]) => void;
  onExcludeKeywordsChange: (fn: (prev: string[]) => string[]) => void;
  // User-state skips
  skipApplied: boolean;
  skipHidden: boolean;
  onSkipAppliedChange: (b: boolean) => void;
  onSkipHiddenChange: (b: boolean) => void;
  // Save action
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  // Non-null when the last save attempt failed; rendered as red text next
  // to the Save button so the user doesn't assume a 4xx/5xx was a success.
  error: string | null;
}

const TIER_OPTIONS: { value: TierFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "top-or-better", label: `Top ${ELITE_COUNT + TOP_COUNT}` },
  { value: "elite", label: `Top ${ELITE_COUNT}` },
];

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/45">
          {label}
        </h3>
        {hint && <span className="text-[10px] text-white/40">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Chip({
  active,
  onClick,
  children,
  tone = "neutral",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "neutral" | "danger";
}) {
  const activeStyles =
    tone === "danger"
      ? "border-red-400/40 bg-red-500/15 text-red-200"
      : "border-white/30 bg-white/10 text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
        active
          ? activeStyles
          : "border-white/10 bg-transparent text-white/55 hover:border-white/20 hover:bg-white/[0.04]"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (b: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="flex items-center gap-2.5 text-left w-full group"
      aria-pressed={on}
    >
      <span
        className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${
          on ? "bg-emerald-500/60" : "bg-white/12"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
            on ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
      <span className="text-[12px] text-white/65 group-hover:text-white/85 transition-colors">
        {label}
      </span>
    </button>
  );
}

// Add-a-keyword input + chip display. Mirrors FilterRail's chip pattern,
// including the amber-dim treatment for keywords absent from the corpus
// (knownKeywords) so the user can tell when a typed keyword will silently
// match nothing.
function KeywordRow({
  placeholder,
  inputValue,
  onInputChange,
  onAdd,
  values,
  onRemove,
  knownKeywords,
  tone,
}: {
  placeholder: string;
  inputValue: string;
  onInputChange: (s: string) => void;
  onAdd: () => void;
  values: string[];
  onRemove: (k: string) => void;
  knownKeywords: Set<string>;
  tone: "include" | "exclude";
}) {
  const activeChipStyles =
    tone === "include"
      ? "bg-white/10 text-white/70"
      : "bg-red-500/10 text-red-400";
  const dimChipStyles =
    tone === "include"
      ? "bg-amber-500/10 text-amber-400/80 line-through decoration-amber-400/50"
      : "bg-white/[0.04] text-white/30 line-through decoration-white/20";
  return (
    <>
      <div className="flex gap-1.5">
        <Input
          placeholder={placeholder}
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onAdd()}
          className="h-7 text-[12px] bg-white/[0.04] border-white/10"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px] border-white/10 bg-white/[0.04]"
          onClick={onAdd}
        >
          Add
        </Button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {values.map((k) => {
            const unknown = !knownKeywords.has(k.toLowerCase());
            const tooltip =
              tone === "include"
                ? "Not in any posting's tags — gate will block every notification"
                : "Not in any posting's tags — has no effect on notifications";
            return (
              <span
                key={k}
                title={unknown ? tooltip : undefined}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
                  unknown ? dimChipStyles : activeChipStyles
                }`}
              >
                {k}
                <button onClick={() => onRemove(k)}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}

export function NotifModal({
  open,
  onOpenChange,
  minScore,
  onMinScoreChange,
  sourceDownAlerts,
  onSourceDownAlertsChange,
  tierFilter,
  onTierFilterChange,
  selectedSeasons,
  onSeasonsToggle,
  seasonOptions,
  dynamicSources,
  excludedSources,
  onExcludedSourcesChange,
  excludeNonUS,
  onExcludeNonUSChange,
  includeKeywords,
  excludeKeywords,
  knownKeywords,
  onIncludeKeywordsChange,
  onExcludeKeywordsChange,
  skipApplied,
  skipHidden,
  onSkipAppliedChange,
  onSkipHiddenChange,
  onSave,
  saving,
  saved,
  error,
}: Props) {
  const [includeInput, setIncludeInput] = useState("");
  const [excludeInput, setExcludeInput] = useState("");

  function addInclude() {
    const trimmed = includeInput.trim();
    if (!trimmed) return;
    onIncludeKeywordsChange((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setIncludeInput("");
  }
  function addExclude() {
    const trimmed = excludeInput.trim();
    if (!trimmed) return;
    onExcludeKeywordsChange((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setExcludeInput("");
  }
  function toggleSource(s: string) {
    onExcludedSourcesChange((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-[oklch(0.18_0.005_260)] border-white/15 text-white p-5 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white text-[15px] font-semibold">
            <Bell className="h-3.5 w-3.5 text-white/60" />
            Notifications
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5 py-1">
          <Section label="Min score" hint="0 = alert on everything">
            <Input
              type="number"
              min={0}
              max={100}
              value={minScore}
              onChange={(e) => onMinScoreChange(Number(e.target.value))}
              className="w-20 h-7 text-[13px] bg-white/[0.04] border-white/10 tabular-nums"
            />
          </Section>

          <Section label="Tier">
            <div className="flex flex-wrap gap-1.5">
              {TIER_OPTIONS.map(({ value, label }) => (
                <Chip
                  key={value}
                  active={tierFilter === value}
                  onClick={() => onTierFilterChange(value)}
                >
                  {label}
                </Chip>
              ))}
            </div>
          </Section>

          <Section label="Seasons" hint="empty = all">
            <div className="flex flex-wrap gap-1.5">
              {seasonOptions.length === 0 ? (
                <span className="text-[11px] text-white/40">None detected yet</span>
              ) : (
                seasonOptions.map(({ token, count }) => (
                  <Chip
                    key={token}
                    active={selectedSeasons.includes(token)}
                    onClick={() => onSeasonsToggle(token)}
                  >
                    {formatSeasonLabel(token)}{" "}
                    <span className="text-white/35 tabular-nums">{count}</span>
                  </Chip>
                ))
              )}
            </div>
          </Section>

          <Section label="Skip sources" hint="silence noisy sources">
            <div className="flex flex-wrap gap-1.5">
              {!dynamicSources || dynamicSources.length === 0 ? (
                <span className="text-[11px] text-white/40">No sources loaded yet</span>
              ) : (
                dynamicSources.map((s) => (
                  <Chip
                    key={s}
                    active={excludedSources.includes(s)}
                    tone="danger"
                    onClick={() => toggleSource(s)}
                  >
                    {s}
                  </Chip>
                ))
              )}
            </div>
          </Section>

          <Section label="Location">
            <Toggle on={excludeNonUS} onChange={onExcludeNonUSChange} label="Skip non-US postings" />
          </Section>

          <Section label="Include keywords" hint="match scorer tags">
            <KeywordRow
              placeholder="e.g. React"
              inputValue={includeInput}
              onInputChange={setIncludeInput}
              onAdd={addInclude}
              values={includeKeywords}
              onRemove={(k) => onIncludeKeywordsChange((prev) => prev.filter((x) => x !== k))}
              knownKeywords={knownKeywords}
              tone="include"
            />
          </Section>

          <Section label="Exclude keywords">
            <KeywordRow
              placeholder="e.g. PhD"
              inputValue={excludeInput}
              onInputChange={setExcludeInput}
              onAdd={addExclude}
              values={excludeKeywords}
              onRemove={(k) => onExcludeKeywordsChange((prev) => prev.filter((x) => x !== k))}
              knownKeywords={knownKeywords}
              tone="exclude"
            />
          </Section>

          <Section label="User state">
            <div className="space-y-2">
              <Toggle on={skipApplied} onChange={onSkipAppliedChange} label="Skip applied postings" />
              <Toggle on={skipHidden} onChange={onSkipHiddenChange} label="Skip hidden postings" />
            </div>
          </Section>

          <Section label="Alerts">
            <Toggle
              on={sourceDownAlerts}
              onChange={onSourceDownAlertsChange}
              label="Alert when a source goes down"
            />
          </Section>
        </div>
        <DialogFooter showCloseButton={false} className="pt-2">
          {error && (
            <span className="text-[11px] text-red-400 self-center mr-2" role="alert">
              {error}
            </span>
          )}
          <Button
            size="sm"
            onClick={onSave}
            disabled={saving}
            className="h-7 bg-white text-[oklch(0.13_0.005_260)] hover:bg-white/90 text-[12px] font-medium border-0"
          >
            {saved ? (
              <span className="inline-flex items-center gap-1">
                <Check className="h-3 w-3" /> Saved
              </span>
            ) : saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
