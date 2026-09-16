"use client";

import { useEffect, useState } from "react";
import { DEFAULT_NOTIF_SETTINGS, parseNotifSettings, type NotifSettings } from "@/lib/notifSettings";
import { ownerHeader } from "../_lib/ownerHeader";

export interface UseNotifSettings {
  settings: NotifSettings;
  update: (patch: Partial<NotifSettings>) => void;
  saving: boolean;
  /** True for 2s after a successful save. */
  saved: boolean;
  error: string | null;
  save: () => Promise<void>;
}

export function useNotifSettings(): UseNotifSettings {
  const [settings, setSettings] = useState<NotifSettings>(DEFAULT_NOTIF_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internships/settings", { headers: ownerHeader() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setSettings(parseNotifSettings(d)); })
      .catch(() => {});
  }, []);

  const update = (patch: Partial<NotifSettings>) => setSettings((s) => ({ ...s, ...patch }));

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/internships/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ownerHeader() },
        body: JSON.stringify(settings),
      });
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

  return { settings, update, saving, saved, error, save };
}
