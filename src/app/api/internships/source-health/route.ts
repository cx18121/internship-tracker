import { getInternships, getStats } from "@/lib/store";

export const dynamic = "force-dynamic";

// Sources whose pollers were removed. Their historical rows linger and get
// their seenAt bumped by cross-source dedup rediscovery, so the last7d>0
// heuristic alone keeps re-surfacing them as permanent "down" entries. Exclude
// them explicitly. (Rows still render in the list view via their source badge;
// this only hides them from the source-health panel.)
const RETIRED_SOURCES = new Set(["Google", "Inhouse", "Workable"]);

export async function GET() {
  const [internships, stats] = await Promise.all([
    getInternships({ includeArchived: true }),
    getStats(),
  ]);
  const { lastCycleSourceCounts, lastCycleNetNewBySource } = stats;

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  type Entry = {
    total: number;
    last24h: number;
    last7d: number;
    lastSeenAt: string | null;
    lastCycleRaw: number;
    lastCycleNetNew: number;
  };
  const sourceMap = new Map<string, Entry>();

  function getOrInit(name: string): Entry {
    let entry = sourceMap.get(name);
    if (!entry) {
      entry = {
        total: 0,
        last24h: 0,
        last7d: 0,
        lastSeenAt: null,
        lastCycleRaw: 0,
        lastCycleNetNew: 0,
      };
      sourceMap.set(name, entry);
    }
    return entry;
  }

  for (const i of internships) {
    const entry = getOrInit(i.source);
    entry.total++;
    const seenAt = i.seenAt;
    const age = now - new Date(seenAt).getTime();
    if (age <= day) entry.last24h++;
    if (age <= 7 * day) entry.last7d++;
    if (!entry.lastSeenAt || new Date(seenAt) > new Date(entry.lastSeenAt)) {
      entry.lastSeenAt = seenAt;
    }
  }

  // Layer in last-cycle counts, including sources that fetched but contributed
  // zero net-new (those won't show up via stored rows alone).
  for (const [name, raw] of Object.entries(lastCycleSourceCounts ?? {})) {
    getOrInit(name).lastCycleRaw = raw;
  }
  for (const [name, n] of Object.entries(lastCycleNetNewBySource ?? {})) {
    getOrInit(name).lastCycleNetNew = n;
  }

  const sources = Array.from(sourceMap.entries())
    .map(([name, counts]) => ({ name, ...counts }))
    // Hide retired sources (see RETIRED_SOURCES) outright, plus any source
    // that's neither polled this cycle nor contributed a row in the last 7
    // days — historical-only rows shouldn't read as a live, down source.
    .filter((s) => !RETIRED_SOURCES.has(s.name) && (s.last7d > 0 || s.lastCycleRaw > 0))
    .sort((a, b) => b.total - a.total);
  return Response.json({ sources });
}
