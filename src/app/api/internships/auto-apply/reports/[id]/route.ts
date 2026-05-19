import { loadReports } from "@/poller/auto-apply";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const report = loadReports()[id];
  if (!report) return Response.json({ error: "No report for this internship" }, { status: 404 });
  return Response.json(report);
}
