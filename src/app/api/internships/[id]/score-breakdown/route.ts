import { getInternship } from "@/lib/store";
import { scoreInternship } from "@/lib/scorer";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const internship = await getInternship((await ctx.params).id);
  if (!internship) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(scoreInternship(internship));
}
