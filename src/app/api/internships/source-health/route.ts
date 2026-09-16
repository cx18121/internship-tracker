import { getSourceHealth, getPollStats } from "@/lib/store";

export const dynamic = "force-dynamic";

// Sources whose pollers were removed. Their rows linger and get seen_at bumped
// by cross-source rediscovery, so hide them from the health panel explicitly.
const RETIRED_SOURCES = new Set(["Google", "Inhouse"]);

export async function GET() {
  const [rows, poll] = await Promise.all([getSourceHealth(), getPollStats()]);
  const names = new Set([...rows.map(r => r.name), ...Object.keys(poll.sourceCounts)]);
  const sources = [...names]
    .map(name => {
      const r = rows.find(x => x.name === name);
      return {
        name,
        total: r?.total ?? 0,
        last24h: r?.last24h ?? 0,
        last7d: r?.last7d ?? 0,
        lastSeenAt: r?.lastSeenAt ?? null,
        lastCycleRaw: poll.sourceCounts[name] ?? 0,
        lastCycleNetNew: poll.netNewBySource[name] ?? 0,
      };
    })
    // A source neither polled last cycle nor seen in 7 days is history, not down.
    .filter(s => !RETIRED_SOURCES.has(s.name) && (s.last7d > 0 || s.lastCycleRaw > 0))
    .sort((a, b) => b.total - a.total);
  return Response.json({ sources });
}
