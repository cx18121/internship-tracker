import { loadReports } from "@/poller/auto-apply";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(loadReports());
}
