import { patchInternship } from "@/lib/store";
import type { Internship } from "@/lib/types";

export const dynamic = "force-dynamic";

const ALLOWED = ["applied", "isNew", "appliedAt", "applicationUrl", "applicationStatus"] as const;

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const patch: Partial<Internship> = {};
  for (const key of ALLOWED) {
    if (key in body) (patch as Record<string, unknown>)[key] = body[key];
  }
  const result = patchInternship(id, patch);
  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(result);
}
