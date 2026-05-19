export const dynamic = "force-dynamic";

const startedAt = Date.now();

export async function GET() {
  return Response.json({ ok: true, uptime: (Date.now() - startedAt) / 1000 });
}
