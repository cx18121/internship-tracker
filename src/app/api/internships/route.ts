import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { getInternships } from "@/lib/store";
import { pickListFields } from "@/app/_lib/list-item";
import { isOwnerRequest } from "@/lib/owner";

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
  // Hidden postings are owner-only state. Non-owners get them stripped from
  // the response regardless of the query param, so a friend can't reveal what
  // the owner hid by passing ?includeHidden=1.
  const wantsHidden = sp.get("includeHidden") === "1" || sp.get("hidden") === "1";
  const includeHidden = wantsHidden && isOwnerRequest(request);

  const all = await getInternships({ source, sources, minScore, label, sort, search: q, includeHidden });
  const sliced = limit !== undefined ? all.slice(offset, offset + limit) : all.slice(offset);
  const body = JSON.stringify(sliced.map(pickListFields));

  // ETag = short hash of the body. If the client already has this version
  // cached (via If-None-Match), skip transferring the whole payload.
  // Cheap on the server (sha1 of a JSON string is fast), instant on the
  // client (304 returns an empty body).
  const etag = `W/"${createHash("sha1").update(body).digest("base64").slice(0, 22)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  // Next.js 16 doesn't auto-compress dynamic API responses, and this payload
  // is the biggest hit on first load (~2.1MB raw → ~410KB gzip). Gzip when
  // the client signals support; otherwise return raw. Brotli isn't in the
  // stdlib's sync API, so gzip is the sweet spot of "free" + universally
  // supported by browsers.
  const acceptEncoding = request.headers.get("accept-encoding") ?? "";
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ETag: etag,
    Vary: "Accept-Encoding",
  };
  if (acceptEncoding.includes("gzip")) {
    const compressed = gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers["content-length"] = String(compressed.byteLength);
    return new Response(compressed, { headers });
  }
  headers["content-length"] = String(Buffer.byteLength(body));
  return new Response(body, { headers });
}
