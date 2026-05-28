import { patchInternship } from "@/lib/store";
import { isOwnerRequest, forbidden } from "@/lib/owner";
import type { Internship } from "@/lib/types";

export const dynamic = "force-dynamic";

// Whitelist of fields a PATCH may set. Anything not listed here is silently
// dropped — extend deliberately. `archivedLink` is intentionally NOT here:
// it has no column in the store; the daily ATS-link script sends it as a
// hint but we don't persist it.
const ALLOWED = [
  "applied",
  "isNew",
  "appliedAt",
  "applicationUrl",
  "applicationStatus",
  "hidden",
  "link",
] as const;

// Per-field validators. Each returns the coerced value on success or the
// `INVALID` sentinel on failure so the route can return 400 with the
// offending field name. Centralised here (not in the store) because input
// validation is an API-layer concern — internal callers of patchInternship
// already provide typed values.
const INVALID = Symbol("invalid");

function isISODateString(v: string): boolean {
  // Accept full ISO 8601 (with or without ms) — what new Date().toISOString() produces.
  if (typeof v !== "string") return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(v);
}

// Length caps so a malformed/malicious client (even an owner one) can't
// silently bloat a row with megabytes of text. URLs above 2KB are well past
// what any real ATS produces; statuses are short freeform strings.
const MAX_URL_LEN = 2048;
const MAX_STATUS_LEN = 200;

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const validators: Record<(typeof ALLOWED)[number], (v: unknown) => unknown | typeof INVALID> = {
  applied: (v) => (typeof v === "boolean" ? v : INVALID),
  isNew: (v) => (typeof v === "boolean" ? v : INVALID),
  hidden: (v) => (typeof v === "boolean" ? v : INVALID),
  appliedAt: (v) => {
    if (v === null) return undefined;
    return typeof v === "string" && isISODateString(v) ? v : INVALID;
  },
  applicationUrl: (v) => {
    if (v === null) return undefined;
    if (typeof v !== "string" || v.length > MAX_URL_LEN || !isHttpUrl(v)) return INVALID;
    return v;
  },
  applicationStatus: (v) => {
    if (v === null) return undefined;
    if (typeof v !== "string" || v.length > MAX_STATUS_LEN) return INVALID;
    return v;
  },
  link: (v) => {
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_URL_LEN || !isHttpUrl(v)) return INVALID;
    return v;
  },
};

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!isOwnerRequest(request)) return forbidden();
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const patch: Partial<Internship> = {};
  for (const key of ALLOWED) {
    if (!(key in body)) continue;
    const coerced = validators[key](body[key]);
    if (coerced === INVALID) {
      return Response.json(
        { error: `Invalid value for field "${key}"` },
        { status: 400 },
      );
    }
    (patch as Record<string, unknown>)[key] = coerced;
  }
  const result = await patchInternship(id, patch);
  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(result);
}
