import type { Internship } from '../lib/types';
import { pool } from '../lib/concurrency';
import { checkLinkStatus } from './ats';
import type { NotifSettings } from '../lib/notifSettings';
import { applyFilterSpec } from '../lib/filter-spec';
import { getState, setState, loadNotifSettings } from '../lib/app-state';
import { classifyLocation } from './iso-locations';

const SOURCE_EMOJIS: Record<string, string> = {
  SimplifyJobs: '⭐',
  LinkedIn: '💼',
};

/** A posting the source dates older than this is news to the tracker, not to the user. */
const MAX_NOTIFY_AGE_DAYS = 14;

export function isFreshEnough(i: Pick<Internship, 'postedAt'>, now = Date.now()): boolean {
  if (!i.postedAt) return true;
  return now - Date.parse(i.postedAt) <= MAX_NOTIFY_AGE_DAYS * 86_400_000;
}

function passesNotifFilters(i: Internship, f: NotifSettings): boolean {
  if ((i.score ?? 0) < f.minScore) return false;
  if (!isFreshEnough(i)) return false;
  if (f.excludeNonUS && classifyLocation(i.location) === 'non_us') return false;
  return applyFilterSpec(i, {
    tiers: f.tiers,
    seasons: f.seasons,
    excludeSources: f.excludedSources,
    roleTypes: f.roleTypes,
    degrees: f.degrees,
    metros: f.metros,
  });
}

// Aggregated sources sometimes list roles already closed upstream. Drop only
// on a definitive 404/410; anything else (throttling, auth walls) fails open.
async function isLinkLive(url: string): Promise<boolean> {
  const status = await checkLinkStatus(url, 5000);
  return status !== 404 && status !== 410;
}

/** Push every new posting that passes the user's gates to Discord, best first. */
export async function sendBatchAlert(newInternships: Internship[]): Promise<number> {
  const settings = await loadNotifSettings();
  const eligible = newInternships
    .filter(i => passesNotifFilters(i, settings))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (eligible.length === 0) {
    console.log(`[notifier] No postings passed filters (minScore=${settings.minScore} tiers=[${settings.tiers.join(',')}] seasons=[${settings.seasons.join(',')}])`);
    return 0;
  }

  const liveness: boolean[] = [];
  await pool(eligible, 8, async (p) => { liveness[eligible.indexOf(p)] = await isLinkLive(p.link); });
  const live = eligible.filter((_, idx) => liveness[idx]);
  if (live.length < eligible.length) {
    console.log(`[notifier] Dropped ${eligible.length - live.length}/${eligible.length} postings with dead links`);
  }

  let sent = 0;
  for (const posting of live) {
    if (await discordPost(buildPostingEmbed(posting))) sent++;
    // Stay under Discord's per-channel limit (~5 messages / 5s).
    await new Promise(r => setTimeout(r, 1100));
  }
  return sent;
}

/**
 * POST a message to the configured Discord channel. Retries once on 429.
 * Returns false without throwing when unconfigured or when Discord rejects.
 */
async function discordPost(body: object): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_INTERNSHIPS;
  if (!token || !channelId) {
    console.error('[notifier] DISCORD_BOT_TOKEN or DISCORD_CHANNEL_INTERNSHIPS not set; skipping');
    return false;
  }

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: JSON.stringify(body),
  };

  try {
    let res = await fetch(url, init);
    if (res.status === 429) {
      const { retry_after = 1 } = await res.json().catch(() => ({})) as { retry_after?: number };
      await new Promise(r => setTimeout(r, Math.ceil(retry_after * 1000) + 100));
      res = await fetch(url, init);
    }
    if (!res.ok) console.error(`[notifier] Discord post failed ${res.status}: ${await res.text().catch(() => '')}`);
    return res.ok;
  } catch (err) {
    console.error('[notifier] Discord post failed:', err);
    return false;
  }
}

function buildPostingEmbed(posting: Internship): object {
  const sourceEmoji = SOURCE_EMOJIS[posting.source];
  const fields = [
    { name: 'Score', value: `${posting.scoreLabel ?? '—'} (${posting.score ?? 0})${posting.companyTier && posting.companyTier !== 'other' ? ` · ${posting.companyTier}` : ''}`, inline: true },
    { name: 'Location', value: posting.location || 'Unknown', inline: true },
    { name: 'Source', value: posting.source, inline: true },
  ];
  if (posting.degrees && posting.degrees.length > 0 && !posting.degrees.includes('bs')) {
    fields.push({ name: 'Degree', value: posting.degrees.map(d => d.toUpperCase()).join(' / '), inline: true });
  }
  if (posting.salaryText) fields.push({ name: 'Salary', value: posting.salaryText, inline: true });

  return {
    embeds: [{
      title: `${sourceEmoji ? sourceEmoji + ' ' : ''}${posting.company} — ${posting.title}`,
      url: posting.link,
      color: posting.scoreLabel === 'A' ? 0x00ff88 : 0x5865f2,
      fields,
      footer: { text: posting.id },
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Apply', url: posting.link }] }],
  };
}

// ---------------------------------------------------------------------------
// Source-down alerts
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** source name → ISO timestamp of the last successful fetch. */
type FetchHistory = Record<string, string>;
/** source name → ISO timestamp when we alerted that it was down. */
type AlertedSources = Record<string, string>;

export async function recordSourceFetches(sources: Iterable<string>): Promise<void> {
  const history = await getState<FetchHistory>('source-fetch-history', {});
  const now = new Date().toISOString();
  for (const s of sources) history[s] = now;
  await setState('source-fetch-history', history);
}

/**
 * A source is down when its last successful fetch is older than 24h but
 * newer than 7d (older than that means retired, not down). Alert state is
 * only updated after Discord accepts the message, so a failed post retries
 * next cycle.
 */
export async function checkAndAlertSourceHealth(): Promise<void> {
  if (!(await loadNotifSettings()).sourceDownAlerts) return;

  const now = Date.now();
  const history = await getState<FetchHistory>('source-fetch-history', {});
  const alerted = await getState<AlertedSources>('source-alerts', {});

  const downNow: string[] = [];
  const recoveredNow: string[] = [];
  for (const [source, lastIso] of Object.entries(history)) {
    const age = now - new Date(lastIso).getTime();
    if (age > DAY_MS && age <= 7 * DAY_MS && !alerted[source]) downNow.push(source);
    else if (age <= DAY_MS && alerted[source]) recoveredNow.push(source);
  }
  if (downNow.length === 0 && recoveredNow.length === 0) return;

  let mutated = false;
  if (downNow.length > 0 && await discordPost({ content: `⚠️ **Source(s) quiet for 24h+**: ${downNow.join(', ')}\nNo new records since the last cycle — check the poller logs.` })) {
    const stamp = new Date().toISOString();
    for (const s of downNow) alerted[s] = stamp;
    mutated = true;
  }
  if (recoveredNow.length > 0 && await discordPost({ content: `✅ **Source(s) back online**: ${recoveredNow.join(', ')}` })) {
    for (const s of recoveredNow) delete alerted[s];
    mutated = true;
  }
  if (mutated) await setState('source-alerts', alerted);
}
