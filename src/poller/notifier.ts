import { Internship } from '../lib/types';
import { checkLinkStatus } from '../lib/store';
import { loadNotifSettings, NotifSettings } from '../lib/notifSettings';
import { applyFilterSpec } from '../lib/filter-spec';
import { jsonStore } from '../lib/sidecar';
import { classifyLocation } from './iso-locations';
import { sendEmailAlert } from './channels/email';
import { sendSmsAlert } from './channels/sms';

// Live-link check for outbound notifications. SimplifyJobs's aggregated
// data sometimes includes roles that have already been closed on the
// upstream ATS — discovery says "new role!", we send a Discord embed
// with the link, user clicks → Workday 404. The daily revalidateLinks()
// catches these eventually, but for first-ingest notifications we need
// a check at send time.
//
// Suppress only on definitively-dead statuses (404, 410). Transient or
// ambiguous codes (401/403/5xx/-1) → fail open and let the message through:
// some tenants throttle HEAD requests but still serve the role to users.
async function isLinkLive(url: string): Promise<boolean> {
  if (!url) return false;
  const status = await checkLinkStatus(url, 5000).catch(() => -1);
  return status !== 404 && status !== 410;
}

const SOURCE_EMOJIS: Record<string, string> = {
  SimplifyJobs: '⭐',
  LinkedIn: '💼',
  Handshake: '🤝',
};

function passesNotifFilters(i: Internship, f: NotifSettings): boolean {
  // Non-US gate is notifier-only — uses the structured location
  // classifier from src/poller/, which doesn't belong in the
  // browser-importable shared spec. 'unknown' classifications
  // (unstructured strings like "Remote" or "NYC") pass through.
  if (f.excludeNonUS && classifyLocation(i.location || '') === 'non_us') {
    return false;
  }
  // Everything else routes through the spec shared with the app
  // table — keeps tier/seasons/source/keyword/role semantics in
  // one place so the two surfaces don't drift.
  return applyFilterSpec(i, {
    tier: f.tierFilter,
    seasons: f.seasons,
    appliedFilter: f.skipApplied ? 'not-applied' : 'all',
    excludeHidden: f.skipHidden,
    excludeSources: f.excludedSources,
    includeKeywords: f.includeKeywords,
    excludeKeywords: f.excludeKeywords,
    roles: f.roles,
  });
}

export async function sendBatchAlert(
  newInternships: Internship[],
  scoreThresholdFallback: number
): Promise<{ ok: boolean; sentCount: number }> {
  // notif-settings.json is the user-editable source of truth for all four
  // notification gates (score, tier, seasons, source-down). The caller's
  // `scoreThresholdFallback` is used only when the file is missing/invalid.
  const settings = loadNotifSettings();
  const effectiveMinScore = settings.minScore ?? scoreThresholdFallback;

  const eligible = newInternships
    .filter(i => (i.score ?? 0) >= effectiveMinScore)
    .filter(i => passesNotifFilters(i, settings))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);

  if (eligible.length === 0) {
    const gateMsg = settings.tierFilter !== 'all' ? ` tier=${settings.tierFilter}` : '';
    const seasonMsg = settings.seasons.length > 0 ? ` seasons=[${settings.seasons.join(',')}]` : '';
    console.log(`[notifier] No postings passed filters (minScore=${effectiveMinScore}${gateMsg}${seasonMsg}), skipping alert`);
    return { ok: false, sentCount: 0 };
  }

  // Validate links in parallel before sending — drop anything that returns
  // 404/410. Max 10 eligible postings; 5s timeout each; ~1-2s total wall time.
  const liveResults = await Promise.all(
    eligible.map(async (p) => ({ p, live: await isLinkLive(p.link || '') })),
  );
  const live = liveResults.filter(r => r.live).map(r => r.p);
  const dropped = eligible.length - live.length;
  if (dropped > 0) {
    console.log(`[notifier] Dropped ${dropped}/${eligible.length} postings with dead links (404/410)`);
  }
  if (live.length === 0) {
    console.log('[notifier] All eligible postings had dead links — skipping alert');
    return { ok: false, sentCount: 0 };
  }

  const channels = settings.channels ?? { discord: true, email: false, sms: false };

  // Fan out to all enabled channels in parallel (email/sms don't block each other).
  const channelResults = await Promise.all([
    channels.discord ? sendDiscordBatch(live) : Promise.resolve(false),
    channels.email ? sendEmailAlert(live, settings.emailRecipients ?? []) : Promise.resolve(false),
    channels.sms ? sendSmsAlert(live, settings.phoneNumbers ?? []) : Promise.resolve(false),
  ]);

  // sentCount = postings that actually went out via at least one channel.
  // (Pre-fix: caller computed "rows above scoreThreshold" which overreports
  // because tier/season/dead-link drops happen after that.)
  return { ok: channelResults.some(Boolean), sentCount: channelResults.some(Boolean) ? live.length : 0 };
}

/**
 * POST a message to the configured Discord channel. Handles env-var lookup,
 * 429 retry (one attempt, honouring retry_after), and error logging in one
 * place — both the per-posting embed batch and the source-down content
 * messages route through this.
 *
 * Returns true iff Discord acknowledged the POST. Returns false (without
 * throwing) when the bot is unconfigured, the request errored, or the
 * server returned non-2xx after retry.
 */
async function discordPost(body: object): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_INTERNSHIPS;
  if (!token || !channelId) return false;

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: JSON.stringify(body),
  };

  try {
    let res = await fetch(url, init);
    if (res.status === 429) {
      const errBody = await res.clone().json().catch(() => ({ retry_after: 1 })) as { retry_after?: number };
      const waitMs = Math.ceil((errBody.retry_after ?? 1) * 1000) + 100;
      console.warn(`[notifier] 429 from Discord, waiting ${waitMs}ms then retrying once`);
      await new Promise(r => setTimeout(r, waitMs));
      res = await fetch(url, init);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[notifier] Discord post failed ${res.status}: ${text}`);
    }
    return res.ok;
  } catch (err) {
    console.error('[notifier] Discord post failed:', err);
    return false;
  }
}

function buildPostingEmbed(posting: Internship): object {
  const color = posting.scoreLabel === 'A' ? 0x00ff88 : 0x5865f2;
  const sourceEmoji = SOURCE_EMOJIS[posting.source] ?? '';
  const fields = [
    { name: 'Score', value: `${posting.scoreLabel ?? '—'} (${posting.score ?? 0})`, inline: true },
    { name: 'Location', value: posting.location || 'Unknown', inline: true },
    { name: 'Source', value: posting.source || 'Unknown', inline: true },
  ];
  if (posting.salaryText) {
    fields.push({ name: 'Salary', value: posting.salaryText, inline: true });
  }
  // Discord message-component fields:
  //   - LINK buttons (style 5) need `url`, no custom_id, no callback.
  //   - PRIMARY/SECONDARY/DANGER buttons (1/2/4) need a custom_id; clicking
  //     them POSTs to our /api/discord/interactions endpoint.
  // Emoji-only buttons keep the action row narrow enough to fit on one
  // mobile row.
  return {
    embeds: [{
      title: `${sourceEmoji ? sourceEmoji + ' ' : ''}${posting.company} — ${posting.title}`.trim(),
      url: posting.link || undefined,
      color,
      fields,
      footer: { text: posting.id },
    }],
    components: [{
      type: 1, // ACTION_ROW
      components: [
        ...(posting.link ? [{ type: 2, style: 5, label: 'Apply', url: posting.link }] : []),
        { type: 2, style: 3, emoji: { name: '✅' }, custom_id: `applied:${posting.id}` },
        { type: 2, style: 4, emoji: { name: '❌' }, custom_id: `hidden:${posting.id}` },
      ],
    }],
  };
}

async function sendDiscordBatch(live: Internship[]): Promise<boolean> {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CHANNEL_INTERNSHIPS) {
    console.error('[notifier] DISCORD_BOT_TOKEN or DISCORD_CHANNEL_INTERNSHIPS not set; skipping Discord alert');
    return false;
  }

  // Send sequentially with a small delay to stay under Discord's per-channel
  // rate limit (~5 messages / 5s).
  const DELAY_MS = 1100;
  let sentAny = false;

  for (const posting of live) {
    if (await discordPost(buildPostingEmbed(posting))) sentAny = true;
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  return sentAny;
}

// ---------------------------------------------------------------------------
// Source-down detection + alerts
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

interface AlertState {
  // Map of source name → ISO timestamp when we alerted for this outage.
  alertedSources: Record<string, string>;
}

// Shared sidecar — agent.ts writes the per-source fetch timestamps that the
// source-down detector reads here.
const sourceFetchHistoryStore = jsonStore<Record<string, string>>(
  'source-fetch-history.json',
  {},
);
const alertStateStore = jsonStore<AlertState>('source-alerts.json', { alertedSources: {} });

/**
 * Compares per-source fetch activity against the persisted alert state, fires
 * new "down" / "recovered" Discord messages, and updates the state. Gated by
 * the `sourceDownAlerts` toggle in data/notif-settings.json.
 *
 * "Down" rule: the source's last successful fetch (recorded by agent.ts in
 * data/source-fetch-history.json) is older than 24h, but it was fetched
 * successfully within the last 7d. This decouples liveness from row counts:
 * cross-source dedup bumps a stored row's `seenAt` on rediscovery, so
 * counting "rows seen in last 24h" made every Indeed-also-on-Greenhouse
 * posting look like fresh Indeed activity. Reading the fetch-history
 * sidecar instead means "the poller actually called this source's API and
 * got a parseable response" is what gates the alert.
 */
export async function checkAndAlertSourceHealth(): Promise<void> {
  if (!loadNotifSettings().sourceDownAlerts) return;

  const now = Date.now();
  const history = sourceFetchHistoryStore.load();

  const state = alertStateStore.load();
  const downNow: string[] = [];
  const recoveredNow: string[] = [];

  // Only evaluate sources we have any history for — a source we've never
  // successfully fetched isn't "down", it's "not configured". State is NOT
  // mutated in this loop — only after the corresponding Discord post
  // succeeds, so a failed alert doesn't get marked sent (and therefore retries
  // next cycle instead of going silently un-alerted forever).
  for (const [source, lastIso] of Object.entries(history)) {
    const age = now - new Date(lastIso).getTime();
    // Down only if quiet for 24h but had a successful fetch in the last 7d.
    // Anything stale > 7d → don't alert (probably retired/disabled source).
    const isDown = age > DAY_MS && age <= WEEK_MS;
    const isHealthy = age <= DAY_MS;
    const alreadyAlerted = !!state.alertedSources[source];
    if (isDown && !alreadyAlerted) downNow.push(source);
    else if (isHealthy && alreadyAlerted) recoveredNow.push(source);
  }

  if (downNow.length === 0 && recoveredNow.length === 0) return;

  let mutated = false;
  if (downNow.length > 0) {
    const msg = `⚠️ **Source(s) quiet for 24h+**: ${downNow.join(', ')}\nNo new records since the last cycle — check the poller logs.`;
    const ok = await discordPost({ content: msg });
    if (ok) {
      const stamp = new Date().toISOString();
      for (const source of downNow) state.alertedSources[source] = stamp;
      mutated = true;
    } else {
      console.warn(`[notifier] down alert failed to post; will retry next cycle: ${downNow.join(', ')}`);
    }
  }
  if (recoveredNow.length > 0) {
    const msg = `✅ **Source(s) back online**: ${recoveredNow.join(', ')}`;
    const ok = await discordPost({ content: msg });
    if (ok) {
      for (const source of recoveredNow) delete state.alertedSources[source];
      mutated = true;
    } else {
      console.warn(`[notifier] recovery alert failed to post; will retry next cycle: ${recoveredNow.join(', ')}`);
    }
  }

  if (mutated) alertStateStore.save(state);
}

