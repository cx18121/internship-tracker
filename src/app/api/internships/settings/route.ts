import { parseNotifSettings } from "@/lib/notifSettings";
import { loadNotifSettings, saveNotifSettings } from "@/lib/app-state";
import { isOwnerRequest, forbidden } from "@/lib/owner";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isOwnerRequest(request)) return forbidden();
  return Response.json(await loadNotifSettings());
}

export async function POST(request: Request) {
  if (!isOwnerRequest(request)) return forbidden();
  const body = await request.json().catch(() => ({}));
  const merged = parseNotifSettings(body, await loadNotifSettings());
  await saveNotifSettings(merged);
  return Response.json(merged);
}
