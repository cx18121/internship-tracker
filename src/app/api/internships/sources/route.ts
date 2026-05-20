import * as fs from "fs";
import * as path from "path";

export const dynamic = "force-dynamic";

interface AtsTarget {
  ats: string;
  [key: string]: unknown;
}
interface AtsTargetsFile {
  targets: AtsTarget[];
}

export async function GET() {
  try {
    const base = path.join(process.cwd(), "data");
    const atsRaw = JSON.parse(
      fs.readFileSync(path.join(base, "ats-targets.json"), "utf-8"),
    ) as AtsTargetsFile;

    const targets = atsRaw.targets ?? [];

    const byType: Record<string, number> = {};
    for (const t of targets) {
      const key = t.ats ?? "other";
      byType[key] = (byType[key] ?? 0) + 1;
    }

    return Response.json({ total: targets.length, byType });
  } catch {
    return Response.json({ error: "Could not read target files" }, { status: 500 });
  }
}
