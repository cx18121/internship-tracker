import { loadNotifSettings, parseNotifSettings, saveNotifSettings } from "@/lib/notifSettings";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(loadNotifSettings());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const merged = parseNotifSettings(body, loadNotifSettings());
  return Response.json(saveNotifSettings(merged));
}
