import { getInternships } from "@/lib/store";
import { scoreInternship } from "@/lib/scorer";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const all = await getInternships({ includeArchived: true });
  const internship = all.find(i => i.id === id);
  if (!internship) return Response.json({ error: "Not found" }, { status: 404 });
  const breakdown = scoreInternship({
    title: internship.title,
    company: internship.company,
    location: internship.location,
    description: internship.description,
  });
  return Response.json(breakdown);
}
