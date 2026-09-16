import { patchInternship } from "@/lib/store";
import { isOwnerRequest, forbidden } from "@/lib/owner";
import type { InternshipPatch } from "@/lib/store";

export const dynamic = "force-dynamic";

// Fields a PATCH may set. `link` is kept for external tooling that repairs
// apply URLs. Each validator returns the coerced value or INVALID.
const ALLOWED = ["applied", "appliedAt", "hidden", "link"] as const;

const INVALID = Symbol("invalid");
const MAX_URL_LEN = 2048;

function isISODateString(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(new Date(v).getTime());
}

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
  hidden: (v) => (typeof v === "boolean" ? v : INVALID),
  appliedAt: (v) => (v === null ? null : typeof v === "string" && isISODateString(v) ? v : INVALID),
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
  const patch: InternshipPatch = {};
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
