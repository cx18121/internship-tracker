import * as fs from "fs";
import * as path from "path";
import type { Internship } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const internshipsPath = path.join(process.cwd(), "data", "internships.json");
  let internships: Internship[] = [];
  try {
    internships = JSON.parse(fs.readFileSync(internshipsPath, "utf-8"));
  } catch {
    /* empty */
  }

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const sourceMap = new Map<string, { total: number; last24h: number; last7d: number }>();

  for (const i of internships) {
    const entry = sourceMap.get(i.source) ?? { total: 0, last24h: 0, last7d: 0 };
    entry.total++;
    const age = now - new Date(i.seenAt).getTime();
    if (age <= day) entry.last24h++;
    if (age <= 7 * day) entry.last7d++;
    sourceMap.set(i.source, entry);
  }

  const sources = Array.from(sourceMap.entries()).map(([name, counts]) => ({ name, ...counts }));
  return Response.json({ sources });
}
