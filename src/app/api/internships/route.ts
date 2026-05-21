import { getInternships } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET /api/internships?source=&minScore=&label=&limit=&offset=&sort=score|newest|posted&q=
// The page UI expects the body to be unwrapped to a plain array.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sp = url.searchParams;

  const rawSources = sp.get("sources") ?? sp.get("source");
  const multi = rawSources ? rawSources.split(",").map(s => s.trim()).filter(Boolean) : undefined;
  const source = multi && multi.length === 1 ? multi[0] : (sp.get("source") && !multi ? sp.get("source")! : undefined);

  const rawScore = sp.get("minScore") ? parseInt(sp.get("minScore")!, 10) : undefined;
  const minScore = rawScore !== undefined && Number.isFinite(rawScore)
    ? Math.max(0, Math.min(rawScore, 100))
    : undefined;

  const label = sp.get("label") ?? undefined;
  // Default raised from 500 → 2000 so the dense list view doesn't clip the
  // long tail of postings (active corpus is ~1.8k and growing). Hard cap
  // stays at 2000 to keep response payloads bounded.
  const limit = Math.min(Math.max(parseInt(sp.get("limit") ?? "", 10) || 2000, 1), 2000);
  const offset = Math.max(parseInt(sp.get("offset") ?? "", 10) || 0, 0);
  const sortParam = sp.get("sort");
  const sort: "newest" | "posted" | "score" =
    sortParam === "newest" || sortParam === "posted" ? sortParam : "score";
  const q = sp.get("q")?.trim() || undefined;
  const includeHidden = sp.get("includeHidden") === "1" || sp.get("hidden") === "1";

  const all = getInternships({ source, minScore, label, sort, search: q, includeHidden });
  return Response.json(all.slice(offset, offset + limit));
}
