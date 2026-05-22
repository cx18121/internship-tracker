import { loadATSTargets } from "@/lib/utils/ats-discovery";

export const dynamic = "force-dynamic";

export async function GET() {
  const targets = loadATSTargets();
  const byType: Record<string, number> = {};
  for (const t of targets) {
    const key = t.ats ?? "other";
    byType[key] = (byType[key] ?? 0) + 1;
  }
  return Response.json({ total: targets.length, byType });
}
