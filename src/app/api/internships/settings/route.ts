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
}

const DEFAULT: NotifSettings = {
  minScore: 50,
  sourceDownAlerts: false,
  tierFilter: "all",
  seasons: [],
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
  };
  return Response.json(save(next));
}
