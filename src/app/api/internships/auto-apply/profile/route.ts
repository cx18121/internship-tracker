import { loadProfile, saveProfile } from "@/poller/auto-apply/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(loadProfile());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  try {
    return Response.json(saveProfile(body));
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
