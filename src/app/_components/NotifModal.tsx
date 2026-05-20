"use client";

import { Bell } from "lucide-react";
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
      <DialogContent className="max-w-md bg-zinc-900 border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white/80">
            <Bell className="h-4 w-4" />
            Notification Settings
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs text-white/40 uppercase tracking-wider">
              Min score for alert notifications
            </label>
            <Input
              type="number"
              min={0}
              max={100}
              value={minScore}
              onChange={(e) => onMinScoreChange(Number(e.target.value))}
              className="w-24 h-8 text-sm bg-white/5 border-white/10"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-white/40 uppercase tracking-wider">Tier</label>
            <div className="flex flex-wrap gap-1.5">
              {TIER_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => onTierFilterChange(value)}
                  className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                    tierFilter === value
                      ? "bg-white/15 border-white/30 text-white"
                      : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-white/40 uppercase tracking-wider">
              Seasons (empty = all)
            </label>
            <div className="flex flex-wrap gap-1.5">
              {seasonOptions.length === 0 ? (
                <span className="text-xs text-white/30">None detected yet</span>
              ) : (
                seasonOptions.map(({ token, count }) => (
                  <button
                    key={token}
                    onClick={() => onSeasonsToggle(token)}
                    className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                      selectedSeasons.includes(token)
                        ? "bg-white/15 border-white/30 text-white"
                        : "bg-white/5 border-white/10 text-white/50 hover:border-white/20"
                    }`}
                  >
                    {formatSeasonLabel(token)} ({count})
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => onSourceDownAlertsChange(!sourceDownAlerts)}
              className={`relative inline-flex h-4 w-8 shrink-0 rounded-full transition-colors ${
                sourceDownAlerts ? "bg-white/40" : "bg-white/10"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${
                  sourceDownAlerts ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
            <span className="text-xs text-white/50">Alert when a source goes down</span>
          </div>
        </div>
        <DialogFooter showCloseButton={false}>
          <Button
            size="sm"
            onClick={onSave}
            disabled={saving}
            className="bg-white/10 hover:bg-white/20 text-white/80 border border-white/10"
          >
            {saved ? "Saved!" : saving ? "Saving…" : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
