import * as fs from "fs";
import * as path from "path";

export const dynamic = "force-dynamic";

const SETTINGS_PATH = path.join(process.cwd(), "data", "notif-settings.json");

type TierFilter = "all" | "top-or-better" | "elite";

interface NotifSettings {
  minScore: number;
  sourceDownAlerts: boolean;
  tierFilter: TierFilter;
  seasons: string[];
  excludedSources: string[];
  excludeNonUS: boolean;
  includeKeywords: string[];
  excludeKeywords: string[];
  skipApplied: boolean;
  skipHidden: boolean;
}

const DEFAULT: NotifSettings = {
  minScore: 50,
  sourceDownAlerts: false,
  tierFilter: "all",
  seasons: [],
  excludedSources: [],
  excludeNonUS: false,
  includeKeywords: [],
  excludeKeywords: [],
  skipApplied: true,
  skipHidden: true,
};

function load(): NotifSettings {
  try {
    return { ...DEFAULT, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULT };
  }
}

function save(settings: NotifSettings): NotifSettings {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return settings;
}

function sanitizeTier(t: unknown): TierFilter {
  return t === "elite" || t === "top-or-better" ? t : "all";
}

function sanitizeSeasons(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  return s
    .filter((x): x is string => typeof x === "string")
    .map(x => x.trim().toLowerCase())
    .filter(x => /^(summer|fall|winter|spring|year)-\d{4}$/.test(x));
}

// Generic string-array sanitizer for the keyword/source lists. Trims,
// drops empties, dedupes, caps at 32 entries to keep the JSON small and
// prevent a runaway settings file from blowing up the notifier loop.
function sanitizeStringList(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of s) {
    if (typeof x !== "string") continue;
    const trimmed = x.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 32) break;
  }
  return out;
}

export async function GET() {
  return Response.json(load());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const current = load();
  const next: NotifSettings = {
    minScore:
      typeof body.minScore === "number"
        ? Math.max(0, Math.min(100, Math.round(body.minScore)))
        : current.minScore,
    sourceDownAlerts:
      typeof body.sourceDownAlerts === "boolean" ? body.sourceDownAlerts : current.sourceDownAlerts,
    tierFilter: "tierFilter" in body ? sanitizeTier(body.tierFilter) : current.tierFilter,
    seasons: "seasons" in body ? sanitizeSeasons(body.seasons) : current.seasons,
    excludedSources:
      "excludedSources" in body ? sanitizeStringList(body.excludedSources) : current.excludedSources,
    excludeNonUS:
      typeof body.excludeNonUS === "boolean" ? body.excludeNonUS : current.excludeNonUS,
    includeKeywords:
      "includeKeywords" in body ? sanitizeStringList(body.includeKeywords) : current.includeKeywords,
    excludeKeywords:
      "excludeKeywords" in body ? sanitizeStringList(body.excludeKeywords) : current.excludeKeywords,
    skipApplied:
      typeof body.skipApplied === "boolean" ? body.skipApplied : current.skipApplied,
    skipHidden:
      typeof body.skipHidden === "boolean" ? body.skipHidden : current.skipHidden,
  };
  return Response.json(save(next));
}
