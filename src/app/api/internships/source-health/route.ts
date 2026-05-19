import { getInternships } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const internships = getInternships({ includeArchived: true });

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  type Entry = { total: number; last24h: number; last7d: number; lastSeenAt: string | null };
  const sourceMap = new Map<string, Entry>();

  for (const i of internships) {
    const entry = sourceMap.get(i.source) ?? { total: 0, last24h: 0, last7d: 0, lastSeenAt: null };
    entry.total++;
    const seenAt = i.seenAt;
    const age = now - new Date(seenAt).getTime();
    if (age <= day) entry.last24h++;
    if (age <= 7 * day) entry.last7d++;
    if (!entry.lastSeenAt || new Date(seenAt) > new Date(entry.lastSeenAt)) {
      entry.lastSeenAt = seenAt;
    }
    sourceMap.set(i.source, entry);
  }

  const sources = Array.from(sourceMap.entries())
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((a, b) => b.total - a.total);
  return Response.json({ sources });
}
