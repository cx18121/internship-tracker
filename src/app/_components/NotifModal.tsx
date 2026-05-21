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
  minScore: number;
  onMinScoreChange: (n: number) => void;
  sourceDownAlerts: boolean;
  onSourceDownAlertsChange: (b: boolean) => void;
  tierFilter: TierFilter;
  onTierFilterChange: (t: TierFilter) => void;
  selectedSeasons: string[];
  onSeasonsToggle: (token: string) => void;
  seasonOptions: SeasonOption[];
  onSave: () => void;
  saving: boolean;
  saved: boolean;
}

const TIER_OPTIONS: { value: TierFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "top-or-better", label: `Top+ (${ELITE_COUNT + TOP_COUNT})` },
  { value: "elite", label: `Elite (${ELITE_COUNT})` },
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
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
        active
          ? "border-white/30 bg-white/10 text-white"
          : "border-white/10 bg-transparent text-white/55 hover:border-white/20 hover:bg-white/[0.04]"
      }`}
    >
      {children}
    </button>
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
  onSave,
  saving,
  saved,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-[oklch(0.18_0.005_260)] border-white/15 text-white p-5">
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

          <Section label="Alerts">
            <button
              type="button"
              onClick={() => onSourceDownAlertsChange(!sourceDownAlerts)}
              className="flex items-center gap-2.5 text-left w-full group"
              aria-pressed={sourceDownAlerts}
            >
              <span
                className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${
                  sourceDownAlerts ? "bg-emerald-500/60" : "bg-white/12"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                    sourceDownAlerts ? "translate-x-3.5" : "translate-x-0.5"
                  }`}
                />
              </span>
              <span className="text-[12px] text-white/65 group-hover:text-white/85 transition-colors">
                Alert when a source goes down
              </span>
            </button>
          </Section>
        </div>
        <DialogFooter showCloseButton={false} className="pt-2">
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
