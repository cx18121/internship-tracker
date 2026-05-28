import { loadNotifSettings, parseNotifSettings, saveNotifSettings } from "@/lib/notifSettings";
import { isOwnerRequest, forbidden } from "@/lib/owner";

export const dynamic = "force-dynamic";

// Notif settings include phone numbers and email recipients, so gate reads
// too — non-owners have no reason to see them.
export async function GET(request: Request) {
  if (!isOwnerRequest(request)) return forbidden();
  return Response.json(loadNotifSettings());
}

export async function POST(request: Request) {
  if (!isOwnerRequest(request)) return forbidden();
  const body = await request.json().catch(() => ({}));
  const merged = parseNotifSettings(body, loadNotifSettings());
  const { ok, settings } = saveNotifSettings(merged);
  if (!ok) {
    return Response.json(
      { error: "Failed to persist notification settings" },
      { status: 500 },
    );
  }
  return Response.json(settings);
}
