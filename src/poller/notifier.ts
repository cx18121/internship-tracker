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

  const settled = await Promise.allSettled(
    eligible.map(posting =>
      fetch('http://localhost:3000/api/discord/internship-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: posting.id,
          company: posting.company,
          role: posting.title,
          score: posting.score ?? 0,
          label: posting.scoreLabel,
          location: posting.location,
          url: posting.link,
        }),
      })
    )
  );

  let sentAny = false;
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value.ok) {
        sentAny = true;
      } else {
        console.error('[notifier] Discord internship-alert failed with status:', result.value.status);
      }
    } else {
      console.error('[notifier] Discord internship-alert failed:', result.reason);
    }
  }

  return sentAny;
}

export async function sendSourceFailureAlert(): Promise<boolean> {
  console.warn(`[notifier] ${consecutiveSourceFailures} consecutive source failures detected`);
  return false;
}

