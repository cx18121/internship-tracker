import twilio from 'twilio';
import type { Internship } from '../../lib/types';

function buildSmsText(postings: Internship[]): string {
  const summaries = postings
    .slice(0, 5)
    .map(p => `${p.company} – ${p.title} (${p.scoreLabel ?? 'C'})`)
    .join(', ');
  const more = postings.length > 5 ? ` +${postings.length - 5} more` : '';
  return `[Tracker] ${postings.length} new match${postings.length !== 1 ? 'es' : ''}: ${summaries}${more}`;
}

export async function sendSmsAlert(
  postings: Internship[],
  phoneNumbers: string[],
): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    console.error('[sms] TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER not set; skipping SMS');
    return false;
  }
  if (phoneNumbers.length === 0) {
    console.warn('[sms] No phone numbers configured; skipping');
    return false;
  }

  const body = buildSmsText(postings);
  const client = twilio(sid, token);
  let sentAny = false;

  for (const to of phoneNumbers) {
    try {
      await client.messages.create({ body, from, to });
      sentAny = true;
    } catch (err) {
      console.error(`[sms] Failed to send to ${to}:`, err);
    }
  }

  if (sentAny) console.log(`[sms] Sent to ${phoneNumbers.length} number(s)`);
  return sentAny;
}
