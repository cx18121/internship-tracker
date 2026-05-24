"use client";

import { useEffect, useState } from "react";
import { isRoleId, type RoleId } from "@/lib/role-taxonomy";
import type { TierFilter } from "../_lib/types";

// All notification-settings state in one place. Previously NotifModal's
// 19 props each had their own useState declaration in page.tsx; the load
// effect was 25 lines of array.isArray + typeof guards, and the save
// handler was inline too. The component still consumes them as
// individual props (lots of independent setters) — this hook just owns
// the state and the load/save flow.
//
// Save errors are surfaced via the `error` field so a failed POST
// doesn't look identical to a successful one. `saved` flips true for
// 2s after a successful save (the green checkmark in the modal's
// footer).

export interface NotifChannels {
  discord: boolean;
  email: boolean;
  sms: boolean;
}

export interface UseNotifSettings {
  minScore: number;
  setMinScore: (n: number) => void;
  sourceDownAlerts: boolean;
  setSourceDownAlerts: (b: boolean) => void;
  tierFilter: TierFilter;
  setTierFilter: (t: TierFilter) => void;
  seasons: string[];
  setSeasons: React.Dispatch<React.SetStateAction<string[]>>;
  excludedSources: string[];
  setExcludedSources: React.Dispatch<React.SetStateAction<string[]>>;
  excludeNonUS: boolean;
  setExcludeNonUS: (b: boolean) => void;
  includeKeywords: string[];
  setIncludeKeywords: React.Dispatch<React.SetStateAction<string[]>>;
  excludeKeywords: string[];
  setExcludeKeywords: React.Dispatch<React.SetStateAction<string[]>>;
  roles: RoleId[];
  setRoles: React.Dispatch<React.SetStateAction<RoleId[]>>;
  skipApplied: boolean;
  setSkipApplied: (b: boolean) => void;
  skipHidden: boolean;
  setSkipHidden: (b: boolean) => void;
  channels: NotifChannels;
  setChannels: React.Dispatch<React.SetStateAction<NotifChannels>>;
  emailRecipients: string[];
  setEmailRecipients: React.Dispatch<React.SetStateAction<string[]>>;
  phoneNumbers: string[];
  setPhoneNumbers: React.Dispatch<React.SetStateAction<string[]>>;
  saving: boolean;
  saved: boolean;
  error: string | null;
  save: () => Promise<void>;
}

export function useNotifSettings(): UseNotifSettings {
  const [minScore, setMinScore] = useState(50);
  const [sourceDownAlerts, setSourceDownAlerts] = useState(false);
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [seasons, setSeasons] = useState<string[]>([]);
  const [excludedSources, setExcludedSources] = useState<string[]>([]);
  const [excludeNonUS, setExcludeNonUS] = useState(false);
  const [includeKeywords, setIncludeKeywords] = useState<string[]>([]);
  const [excludeKeywords, setExcludeKeywords] = useState<string[]>([]);
  const [roles, setRoles] = useState<RoleId[]>([]);
  const [skipApplied, setSkipApplied] = useState(true);
  const [skipHidden, setSkipHidden] = useState(true);
  const [channels, setChannels] = useState<NotifChannels>({ discord: true, email: false, sms: false });
  const [emailRecipients, setEmailRecipients] = useState<string[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load. Each field hydrates only if the server payload has a
  // value of the expected shape — anything else falls back to the
  // useState default, so a server with a partial settings file doesn't
  // overwrite freshly-loaded local state with `undefined`.
  useEffect(() => {
    fetch("/api/internships/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        if (typeof d.minScore === "number") setMinScore(d.minScore);
        if (typeof d.sourceDownAlerts === "boolean") setSourceDownAlerts(d.sourceDownAlerts);
        if (d.tierFilter === "elite" || d.tierFilter === "top-or-better" || d.tierFilter === "all") {
          setTierFilter(d.tierFilter);
        }
        if (Array.isArray(d.seasons)) setSeasons(d.seasons);
        if (Array.isArray(d.excludedSources)) setExcludedSources(d.excludedSources);
        if (typeof d.excludeNonUS === "boolean") setExcludeNonUS(d.excludeNonUS);
        if (Array.isArray(d.includeKeywords)) setIncludeKeywords(d.includeKeywords);
        if (Array.isArray(d.excludeKeywords)) setExcludeKeywords(d.excludeKeywords);
        if (Array.isArray(d.roles)) setRoles(d.roles.filter(isRoleId));
        if (typeof d.skipApplied === "boolean") setSkipApplied(d.skipApplied);
        if (typeof d.skipHidden === "boolean") setSkipHidden(d.skipHidden);
        if (d.channels && typeof d.channels === "object") setChannels(d.channels);
        if (Array.isArray(d.emailRecipients)) setEmailRecipients(d.emailRecipients);
        if (Array.isArray(d.phoneNumbers)) setPhoneNumbers(d.phoneNumbers);
      })
      .catch(() => {});
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/internships/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minScore, sourceDownAlerts, tierFilter, seasons, excludedSources,
          excludeNonUS, includeKeywords, excludeKeywords, roles,
          skipApplied, skipHidden, channels, emailRecipients, phoneNumbers,
        }),
      });
      // fetch() resolves on 4xx/5xx, so a server-side failure looks
      // identical to a successful save unless we inspect res.ok.
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError("Save failed");
      }
    } catch {
      setError("Save failed");
    }
    setSaving(false);
  }

  return {
    minScore, setMinScore,
    sourceDownAlerts, setSourceDownAlerts,
    tierFilter, setTierFilter,
    seasons, setSeasons,
    excludedSources, setExcludedSources,
    excludeNonUS, setExcludeNonUS,
    includeKeywords, setIncludeKeywords,
    excludeKeywords, setExcludeKeywords,
    roles, setRoles,
    skipApplied, setSkipApplied,
    skipHidden, setSkipHidden,
    channels, setChannels,
    emailRecipients, setEmailRecipients,
    phoneNumbers, setPhoneNumbers,
    saving, saved, error,
    save,
  };
}
