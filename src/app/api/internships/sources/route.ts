import { loadATSTargets } from "@/lib/utils/ats-discovery";
import { cachedJsonResponse } from "@/lib/cachedResponse";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const targets = loadATSTargets();
  const byType: Record<string, number> = {};
  for (const t of targets) {
    const key = t.ats ?? "other";
    byType[key] = (byType[key] ?? 0) + 1;
  }
  return cachedJsonResponse(request, { total: targets.length, byType });
}
