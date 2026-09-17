"use client";

import { Bell, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatSeasonLabel } from "@/lib/seasons";
import { KeywordChips } from "./KeywordChips";
import { TIER_LABELS } from "./FilterRail";
import { DEGREE_LABELS } from "../_lib/labels";
import { ROLE_SPECIALIZATIONS, type RoleId } from "@/lib/role-taxonomy";
import type { TierFilter } from "@/lib/filter-spec";
import type { NotifSettings } from "@/lib/notifSettings";

interface SeasonOption {
  token: string;
  count: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: NotifSettings;
  onChange: (patch: Partial<NotifSettings>) => void;
  /** Options derived from the current corpus, for chips. */
  seasonOptions: SeasonOption[];
  sources: string[];
  knownKeywords: Set<string>;
  availableRoles: Set<RoleId>;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  error: string | null;
}

const TIER_OPTIONS = (Object.keys(TIER_LABELS) as TierFilter[]).map((value) => ({ value, label: TIER_LABELS[value] }));

function Section({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`space-y-2 ${className}`}>
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

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function NotifModal({
  open, onOpenChange, settings, onChange, seasonOptions, sources, knownKeywords, availableRoles,
  onSave, saving, saved, error,
}: Props) {
  const s = settings;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl bg-[oklch(0.18_0.005_260)] border-white/15 text-white p-5 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white text-[15px] font-semibold">
            <Bell className="h-3.5 w-3.5 text-white/60" />
            Notifications
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-5 py-1">
          <Section label="Min score" hint="0 = alert on everything">
            <Input
              type="number"
              min={0}
              max={100}
              value={s.minScore}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange({ minScore: Number.isFinite(n) ? n : 0 });
              }}
              className="w-20 h-7 text-[13px] bg-white/[0.04] border-white/10 tabular-nums"
            />
          </Section>

          <Section label="Tier">
            <div className="flex flex-wrap gap-1.5">
              {TIER_OPTIONS.map(({ value, label }) => (
                <Chip
                  key={value}
                  active={s.tierFilter === value}
                  onClick={() => onChange({ tierFilter: value })}
                >
                  {label}
                </Chip>
              ))}
            </div>
          </Section>

          <Section label="Role" hint="empty = all" className="sm:col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {ROLE_SPECIALIZATIONS.map((r) => {
                const active = s.roles.includes(r.id);
                const unknown = !availableRoles.has(r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onChange({ roles: toggle(s.roles, r.id) })}
                    title={unknown ? "No postings currently match this role" : undefined}
                    className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
                      active
                        ? "border-white/30 bg-white/10 text-white"
                        : unknown
                          ? "border-white/[0.06] bg-transparent text-white/25 hover:border-white/15"
                          : "border-white/10 bg-transparent text-white/55 hover:border-white/20 hover:bg-white/[0.04]"
                    }`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section label="Seasons" hint="empty = all" className="sm:col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {seasonOptions.length === 0 ? (
                <span className="text-[11px] text-white/40">None detected yet</span>
              ) : (
                seasonOptions.map(({ token, count }) => (
                  <Chip
                    key={token}
                    active={s.seasons.includes(token)}
                    onClick={() => onChange({ seasons: toggle(s.seasons, token) })}
                  >
                    {formatSeasonLabel(token)}{" "}
                    <span className="text-white/35 tabular-nums">{count}</span>
                  </Chip>
                ))
              )}
            </div>
          </Section>

          <Section label="Skip sources" hint="silence noisy sources" className="sm:col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {sources.length === 0 ? (
                <span className="text-[11px] text-white/40">No sources loaded yet</span>
              ) : (
                sources.map((src) => (
                  <Chip
                    key={src}
                    active={s.excludedSources.includes(src)}
                    tone="danger"
                    onClick={() => onChange({ excludedSources: toggle(s.excludedSources, src) })}
                  >
                    {src}
                  </Chip>
                ))
              )}
            </div>
          </Section>

          <Section label="Degree" hint="empty = all">
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(DEGREE_LABELS) as Array<keyof typeof DEGREE_LABELS>).map((d) => (
                <Chip key={d} active={s.degrees.includes(d)} onClick={() => onChange({ degrees: toggle(s.degrees, d) })}>
                  {DEGREE_LABELS[d]}
                </Chip>
              ))}
            </div>
          </Section>

          <Section label="Location">
            <Toggle on={s.excludeNonUS} onChange={(b) => onChange({ excludeNonUS: b })} label="Skip non-US postings" />
          </Section>

          <Section label="Include keywords" hint="match scorer tags">
            <KeywordChips
              values={s.includeKeywords}
              onValuesChange={(next) => onChange({ includeKeywords: next })}
              placeholder="e.g. React"
              knownKeywords={knownKeywords}
              tone="include"
            />
          </Section>

          <Section label="Exclude keywords">
            <KeywordChips
              values={s.excludeKeywords}
              onValuesChange={(next) => onChange({ excludeKeywords: next })}
              placeholder="e.g. PhD"
              knownKeywords={knownKeywords}
              tone="exclude"
            />
          </Section>

          <Section label="User state">
            <div className="space-y-2">
              <Toggle on={s.skipApplied} onChange={(b) => onChange({ skipApplied: b })} label="Skip applied postings" />
              <Toggle on={s.skipHidden} onChange={(b) => onChange({ skipHidden: b })} label="Skip hidden postings" />
            </div>
          </Section>

          <Section label="Alerts" className="sm:col-span-2">
            <Toggle
              on={s.sourceDownAlerts}
              onChange={(b) => onChange({ sourceDownAlerts: b })}
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
