import { getInternships } from "@/lib/store";
import { detectProvider } from "@/poller/auto-apply";
import { loadProfile } from "@/poller/auto-apply/profile";
import { autoFill } from "@/poller/auto-apply/playwright-fill";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { resumePath } = await request.json().catch(() => ({}));
  const all = getInternships({ includeArchived: true });
  const internship = all.find(i => i.id === id);
  if (!internship) return Response.json({ error: "Internship not found" }, { status: 404 });
  const provider = detectProvider(internship);
  if (!provider) return Response.json({ error: "Cannot detect ATS provider" }, { status: 422 });
  try {
    const out = await autoFill(internship.link, provider, loadProfile(), resumePath ?? "");
    return Response.json(out);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
