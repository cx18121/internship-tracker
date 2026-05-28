import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

// Build a JSON Response with weak ETag + on-demand gzip. Next.js 16 doesn't
// auto-compress dynamic API routes and doesn't add ETag headers, so endpoints
// that return any non-trivial payload route through this helper instead of
// `Response.json`.
//
// - ETag = sha1(body) truncated to 22 chars (weak validator). Cheap to
//   compute; lets the client send `If-None-Match` and get a 304 with no body
//   when the corpus hasn't changed.
// - Gzip kicks in when the request includes `Accept-Encoding: gzip`. Brotli
//   isn't in the stdlib's sync API; gzip is the universal default.
export function cachedJsonResponse(request: Request, payload: unknown): Response {
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash("sha1").update(body).digest("base64").slice(0, 22)}"`;

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ETag: etag,
    Vary: "Accept-Encoding",
  };

  const acceptEncoding = request.headers.get("accept-encoding") ?? "";
  if (acceptEncoding.includes("gzip")) {
    const compressed = gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers["content-length"] = String(compressed.byteLength);
    return new Response(compressed, { headers });
  }
  headers["content-length"] = String(Buffer.byteLength(body));
  return new Response(body, { headers });
}
