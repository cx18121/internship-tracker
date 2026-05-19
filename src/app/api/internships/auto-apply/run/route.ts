import { getInternships, patchInternship } from "@/lib/store";
import { runBatch } from "@/poller/auto-apply";
import { loadSettings } from "@/poller/auto-apply/profile";
import type { Internship } from "@/lib/types";

export const dynamic = "force-dynamic";
// Auto-apply launches Playwright; needs the full Node runtime.
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  const settings = loadSettings();
  if (!settings.enabled) {
    return Response.json({ error: "auto-apply is disabled" }, { status: 403 });
  }
  const all = getInternships({});
  try {
    const result = await runBatch(all);
    for (const report of result.reports) {
      if (!report.error) {
        patchInternship(report.internshipId, { applicationStatus: "auto_fill_ready" } as Partial<Internship>);
      }
    }
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
