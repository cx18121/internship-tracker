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

// Pull the Apply LINK button's URL out of an existing component tree, if any.
// LINK buttons survive every state transition (no custom_id, no callback), so
// they're the only piece we can't rebuild without snooping at what's there.
function extractApplyUrl(components: unknown): string | undefined {
  if (!Array.isArray(components)) return undefined;
  for (const row of components as Array<{ type?: number; components?: unknown[] }>) {
    if (row.type !== 1 || !Array.isArray(row.components)) continue;
    for (const c of row.components as Array<{ type?: number; style?: number; url?: string }>) {
      if (c.type === 2 && c.style === 5 && typeof c.url === 'string') return c.url;
    }
  }
  return undefined;
}

type ButtonState = 'fresh' | 'applied' | 'hidden';

function buildComponents(internshipId: string, applyUrl: string | undefined, state: ButtonState) {
  const buttons: Array<Record<string, unknown>> = [];
  if (applyUrl) {
    buttons.push({ type: 2, style: 5, label: 'Apply', url: applyUrl });
  }
  if (state === 'applied') {
    // Still expose Hide so the user can flip from applied → hidden without
    // a separate undo round-trip. Undo here means: this wasn't actually
    // applied, put it back into the active set.
    buttons.push({ type: 2, style: 2, label: 'Undo apply', custom_id: `unapplied:${internshipId}` });
    buttons.push({ type: 2, style: 4, emoji: { name: '❌' }, custom_id: `hidden:${internshipId}` });
  } else if (state === 'hidden') {
    buttons.push({ type: 2, style: 2, label: 'Undo hide', custom_id: `unhidden:${internshipId}` });
  } else {
    buttons.push({ type: 2, style: 3, emoji: { name: '✅' }, custom_id: `applied:${internshipId}` });
    buttons.push({ type: 2, style: 4, emoji: { name: '❌' }, custom_id: `hidden:${internshipId}` });
  }
  return [{ type: 1, components: buttons }];
}

// The footer originally carried just the internship id. After an applied/hide
// action we appended " · ✅ Marked applied" or " · ❌ Hidden". On undo we strip
// any of those suffixes back to the canonical id.
function stripActionFooter(text: string): string {
  return text
    .replace(/\s*·\s*✅\s*Marked applied$/u, '')
    .replace(/\s*·\s*❌\s*Hidden$/u, '');
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

    const original = body.message ?? {};
    const applyUrl = extractApplyUrl(original.components);
    let nextState: ButtonState;
    let footerNote: string | null;

    if (action === "applied") {
      await patchInternship(internshipId, { applied: true, appliedAt: new Date().toISOString() });
      nextState = 'applied';
      footerNote = '✅ Marked applied';
    } else if (action === "hidden") {
      await patchInternship(internshipId, { hidden: true });
      nextState = 'hidden';
      footerNote = '❌ Hidden';
    } else if (action === "unapplied") {
      await patchInternship(internshipId, { applied: false, appliedAt: undefined });
      nextState = 'fresh';
      footerNote = null;
    } else if (action === "unhidden") {
      await patchInternship(internshipId, { hidden: false });
      nextState = 'fresh';
      footerNote = null;
    } else {
      return Response.json({
        type: 4,
        data: { content: `unknown action: ${action}`, flags: 64 },
      });
    }

    // Rebuild embed footer: strip any prior action suffix, then append the
    // new note if we have one. Cleanly round-trips applied → undone → re-applied.
    const newEmbeds = (original.embeds ?? []).map((e: { footer?: { text?: string }; [k: string]: unknown }) => {
      const base = stripActionFooter(e.footer?.text ?? "");
      const text = footerNote ? `${base}${base ? " · " : ""}${footerNote}` : base;
      return { ...e, footer: { text } };
    });

    return Response.json({
      type: RES_UPDATE_MESSAGE,
      data: {
        embeds: newEmbeds,
        components: buildComponents(internshipId, applyUrl, nextState),
      },
    });
  }

  return Response.json({ type: 1 });
}
