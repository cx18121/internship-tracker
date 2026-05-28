// Server-side owner gate for mutating API routes. The site is shared
// read-only with friends; only requests carrying the matching token in the
// `x-owner-token` header are allowed to mutate internship state or notif
// settings.
//
// The token lives in the `OWNER_TOKEN` env var (set in .env.local + Railway).
// Clients put the same value in `localStorage.ownerToken` and inject the
// header on mutating fetches (see `_lib/ownerHeader.ts`).
//
// If `OWNER_TOKEN` is unset, every owner check fails closed — better to
// 403 every PATCH than to silently allow them.

const OWNER_HEADER = "x-owner-token";

export function isOwnerRequest(request: Request): boolean {
  const expected = process.env.OWNER_TOKEN;
  if (!expected) return false;
  const provided = request.headers.get(OWNER_HEADER);
  return provided === expected;
}

export function forbidden(): Response {
  return Response.json({ error: "Forbidden" }, { status: 403 });
}
