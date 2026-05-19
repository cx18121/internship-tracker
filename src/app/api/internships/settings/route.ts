import * as fs from "fs";
import * as path from "path";

export const dynamic = "force-dynamic";

const SETTINGS_PATH = path.join(process.cwd(), "data", "notif-settings.json");

interface NotifSettings {
  minScore: number;
  sourceDownAlerts: boolean;
}

const DEFAULT: NotifSettings = { minScore: 50, sourceDownAlerts: false };

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

export async function GET() {
  return Response.json(load());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const next: NotifSettings = {
    minScore:
      typeof body.minScore === "number"
        ? Math.max(0, Math.min(100, Math.round(body.minScore)))
        : load().minScore,
    sourceDownAlerts:
      typeof body.sourceDownAlerts === "boolean" ? body.sourceDownAlerts : load().sourceDownAlerts,
  };
  return Response.json(save(next));
}
