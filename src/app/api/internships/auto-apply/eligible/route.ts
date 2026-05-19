import { getInternships } from "@/lib/store";
import { detectProvider, isEligible } from "@/poller/auto-apply";
import { loadSettings } from "@/poller/auto-apply/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = loadSettings();
  const all = getInternships({});
  const eligible = all
    .filter(i => isEligible(i, settings))
    .map(i => ({
      id: i.id,
      title: i.title,
      company: i.company,
      score: i.score,
      scoreLabel: i.scoreLabel,
      provider: detectProvider(i),
      link: i.link,
    }));
  return Response.json({
    count: eligible.length,
    settings: { minScore: settings.minScore, minLabel: settings.minLabel },
    internships: eligible,
  });
}
