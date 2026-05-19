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

  const settled = await Promise.allSettled(
    eligible.map(posting => {
      const color = posting.scoreLabel === 'Excellent' ? 0x00ff88 : 0x5865f2;
      const sourceEmoji = SOURCE_EMOJIS[posting.source] ?? '';
      const body = {
        embeds: [
          {
            title: `${sourceEmoji ? sourceEmoji + ' ' : ''}${posting.company} — ${posting.title}`.trim(),
            url: posting.link || undefined,
            color,
            fields: [
              { name: 'Score', value: `${posting.scoreLabel} (${posting.score ?? 0})`, inline: true },
              { name: 'Location', value: posting.location || 'Unknown', inline: true },
            ],
            footer: { text: posting.id },
          },
        ],
      };
      return fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${token}`,
        },
        body: JSON.stringify(body),
      });
    })
  );

  let sentAny = false;
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value.ok) {
        sentAny = true;
      } else {
        const text = await result.value.text().catch(() => '');
        console.error(`[notifier] Discord post failed ${result.value.status}: ${text}`);
      }
    } else {
      console.error('[notifier] Discord post failed:', result.reason);
    }
  }

  return sentAny;
}

export async function sendSourceFailureAlert(): Promise<boolean> {
  console.warn(`[notifier] ${consecutiveSourceFailures} consecutive source failures detected`);
  return false;
}

