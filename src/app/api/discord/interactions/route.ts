import nacl from "tweetnacl";
import { patchInternship } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discord interaction types
const PING = 1;
const MESSAGE_COMPONENT = 3;

// Response types
const RES_PONG = 1;
const RES_UPDATE_MESSAGE = 7; // Edit the original message in-place

// Component types
const _BUTTON = 2;

function getPublicKey(): string {
  return process.env.DISCORD_PUBLIC_KEY ?? "";
}

function verifySignature(rawBody: string, signature: string, timestamp: string): boolean {
  const publicKey = getPublicKey();
  if (!publicKey || !signature || !timestamp) {
    console.warn("[discord] verify skipped — missing key/sig/ts", {
      hasKey: !!publicKey, hasSig: !!signature, hasTs: !!timestamp,
    });
    return false;
  }
  try {
    const ok = nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, "hex"),
      Buffer.from(publicKey, "hex"),
    );
    if (!ok) console.warn(`[discord] sig mismatch (key prefix=${publicKey.slice(0, 8)}, body len=${rawBody.length}, ts=${timestamp})`);
    return ok;
  } catch (err) {
    console.warn("[discord] verify threw:", (err as Error).message);
    return false;
  }
}

function disableButtons(components: unknown): unknown {
  // Walk the components tree and set `disabled: true` on every button.
  if (!Array.isArray(components)) return components;
  return components.map((row: { components?: unknown[]; type?: number }) => {
    if (row.type !== 1 || !Array.isArray(row.components)) return row;
    const buttons = row.components as Array<{ type?: number; style?: number; [k: string]: unknown }>;
    return {
      ...row,
      components: buttons.map((c) =>
        c.type === 2 && c.style !== 5 ? { ...c, disabled: true } : c,
      ),
    };
  });
}

export async function POST(request: Request) {
  // Read raw body for signature verification — must be the byte-for-byte payload.
  const rawBody = await request.text();
  const signature = request.headers.get("x-signature-ed25519") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";

  if (!verifySignature(rawBody, signature, timestamp)) {
    return new Response("invalid signature", { status: 401 });
  }

  const body = JSON.parse(rawBody);

  // PING — Discord's verification handshake when you register the endpoint
  if (body.type === PING) {
    return Response.json({ type: RES_PONG });
  }

  if (body.type === MESSAGE_COMPONENT) {
    const customId = (body.data?.custom_id ?? "") as string;
    const [action, internshipId] = customId.split(":");

    if (!internshipId) {
      return Response.json({
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data: { content: "missing internship id", flags: 64 },
      });
    }

    if (action === "applied") {
      patchInternship(internshipId, { applied: true, appliedAt: new Date().toISOString() });
    } else if (action === "hidden") {
      patchInternship(internshipId, { hidden: true });
    } else {
      return Response.json({
        type: 4,
        data: { content: `unknown action: ${action}`, flags: 64 },
      });
    }

    // Update the original embed in place: disable the buttons + append a
    // small footer note so it's obvious what was clicked, without spamming
    // the channel with a separate reply.
    const original = body.message ?? {};
    const newEmbeds = (original.embeds ?? []).map((e: { footer?: { text?: string }; [k: string]: unknown }) => ({
      ...e,
      footer: {
        text: `${e.footer?.text ?? ""}${e.footer?.text ? " · " : ""}${
          action === "applied" ? "✅ Marked applied" : "❌ Hidden"
        }`,
      },
    }));

    return Response.json({
      type: RES_UPDATE_MESSAGE,
      data: {
        embeds: newEmbeds,
        components: disableButtons(original.components),
      },
    });
  }

  return Response.json({ type: 1 });
}
