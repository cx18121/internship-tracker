import { Internship } from '../lib/types';

const SOURCE_EMOJIS: Record<string, string> = {
  SimplifyJobs: '⭐',
  LinkedIn: '💼',
  Handshake: '🤝',
};

let consecutiveSourceFailures = 0;

export function recordSourceFailure(): void {
  consecutiveSourceFailures++;
}

export function recordSourceSuccess(): void {
  consecutiveSourceFailures = 0;
}

export async function sendBatchAlert(
  newInternships: Internship[],
  scoreThreshold: number
): Promise<boolean> {
  const eligible = newInternships
    .filter(i => (i.score ?? 0) >= scoreThreshold)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);

  if (eligible.length === 0) {
    console.log('[notifier] No postings above score threshold, skipping alert');
    return false;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_INTERNSHIPS;
  if (!token || !channelId) {
    console.error('[notifier] DISCORD_BOT_TOKEN or DISCORD_CHANNEL_INTERNSHIPS not set; skipping alert');
    return false;
  }

  // Send sequentially with a small delay to stay under Discord's per-channel
  // rate limit (~5 messages / 5s). Honor 429 retry_after on overshoot.
  const DELAY_MS = 1100;
  let sentAny = false;

  for (const posting of eligible) {
    const color = posting.scoreLabel === 'Excellent' ? 0x00ff88 : 0x5865f2;
    const sourceEmoji = SOURCE_EMOJIS[posting.source] ?? '';
    // Discord message-component fields:
    //   - LINK buttons (style 5) need `url`, no custom_id, no callback.
    //   - PRIMARY/SECONDARY/DANGER buttons (1/2/4) need a custom_id; clicking
    //     them POSTs to our /api/discord/interactions endpoint.
    const fields = [
      { name: 'Score', value: `${posting.scoreLabel} (${posting.score ?? 0})`, inline: true },
      { name: 'Location', value: posting.location || 'Unknown', inline: true },
    ];
    if (posting.salaryText) {
      fields.push({ name: 'Salary', value: posting.salaryText, inline: true });
    }
    const body = {
      embeds: [
        {
          title: `${sourceEmoji ? sourceEmoji + ' ' : ''}${posting.company} — ${posting.title}`.trim(),
          url: posting.link || undefined,
          color,
          fields,
          footer: { text: posting.id },
        },
      ],
      components: [
        {
          type: 1, // ACTION_ROW
          components: [
            ...(posting.link ? [{
              type: 2, // BUTTON
              style: 5, // LINK
              label: 'Apply',
              url: posting.link,
            }] : []),
            {
              type: 2,
              style: 3, // SUCCESS (green)
              label: '✅ Applied',
              custom_id: `applied:${posting.id}`,
            },
            {
              type: 2,
              style: 4, // DANGER (red)
              label: '❌ Not interested',
              custom_id: `hidden:${posting.id}`,
            },
          ],
        },
      ],
    };

    // Try once, retry once on 429 honoring retry_after.
    let res: Response;
    try {
      res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        const errBody = await res.clone().json().catch(() => ({ retry_after: 1 })) as { retry_after?: number };
        const waitMs = Math.ceil((errBody.retry_after ?? 1) * 1000) + 100;
        console.warn(`[notifier] 429 from Discord, waiting ${waitMs}ms then retrying once`);
        await new Promise(r => setTimeout(r, waitMs));
        res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
          body: JSON.stringify(body),
        });
      }
      if (res.ok) {
        sentAny = true;
      } else {
        const text = await res.text().catch(() => '');
        console.error(`[notifier] Discord post failed ${res.status}: ${text}`);
      }
    } catch (err) {
      console.error('[notifier] Discord post failed:', err);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  return sentAny;
}

export async function sendSourceFailureAlert(): Promise<boolean> {
  console.warn(`[notifier] ${consecutiveSourceFailures} consecutive source failures detected`);
  return false;
}

