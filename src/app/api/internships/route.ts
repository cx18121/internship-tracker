import { getInternships } from "@/lib/store";
import { pickListFields } from "@/app/_lib/list-item";

export const dynamic = "force-dynamic";

// GET /api/internships?source=&minScore=&label=&limit=&offset=&sort=score|newest|posted&q=
// The page UI expects the body to be unwrapped to a plain array.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sp = url.searchParams;

  const rawSources = sp.get("sources") ?? sp.get("source");
  const multi = rawSources ? rawSources.split(",").map(s => s.trim()).filter(Boolean) : undefined;
  // Single-source path stays the same; multi-source (2+) is now passed
  // through as `sources` instead of being silently collapsed to undefined.
  const sources = multi && multi.length > 1 ? multi : undefined;
  const source = multi && multi.length === 1 ? multi[0] : undefined;

  const rawScore = sp.get("minScore") ? parseInt(sp.get("minScore")!, 10) : undefined;
  const minScore = rawScore !== undefined && Number.isFinite(rawScore)
    ? Math.max(0, Math.min(rawScore, 100))
    : undefined;

  const label = sp.get("label") ?? undefined;
  // Optional caller-supplied limit; absent = no cap. Page paginates client-side.
  const rawLimit = parseInt(sp.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  const offset = Math.max(parseInt(sp.get("offset") ?? "", 10) || 0, 0);
  const sortParam = sp.get("sort");
  const sort: "newest" | "posted" | "score" =
    sortParam === "newest" || sortParam === "posted" ? sortParam : "score";
  const q = sp.get("q")?.trim() || undefined;
  const includeHidden = sp.get("includeHidden") === "1" || sp.get("hidden") === "1";

  const all = await getInternships({ source, sources, minScore, label, sort, search: q, includeHidden });
  const sliced = limit !== undefined ? all.slice(offset, offset + limit) : all.slice(offset);
  return Response.json(sliced.map(pickListFields));
}
