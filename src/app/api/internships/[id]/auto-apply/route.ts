import { getInternships, patchInternship } from "@/lib/store";
import { analyzeFill, detectProvider, isEligible } from "@/poller/auto-apply";
import { loadSettings } from "@/poller/auto-apply/profile";
import type { Internship } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const force = body?.force === true;

  const all = getInternships({ includeArchived: true });
  const internship = all.find(i => i.id === id);
  if (!internship) return Response.json({ error: "Internship not found" }, { status: 404 });

  if (!force) {
    const settings = loadSettings();
    if (!settings.enabled) {
      return Response.json({ error: "auto-apply is disabled" }, { status: 403 });
    }
    if (!isEligible(internship, settings)) {
      return Response.json(
        {
          error: "Does not meet auto-apply criteria",
          score: internship.score,
          minScore: settings.minScore,
          provider: detectProvider(internship),
          providers: settings.providers,
        },
        { status: 422 },
      );
    }
  }

  try {
    const report = await analyzeFill(internship);
    patchInternship(id, { applicationStatus: "auto_fill_ready" } as Partial<Internship>);
    return Response.json(report);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
