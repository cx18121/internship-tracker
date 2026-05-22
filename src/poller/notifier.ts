import * as fs from 'fs';
import * as path from 'path';
import { Internship } from '../lib/types';
import { checkLinkStatus } from '../lib/store';
import { isElite, isTopOrBetter } from '../lib/tiers';
import { parseSeason } from '../lib/seasons';
import { loadNotifSettings, NotifSettings } from '../lib/notifSettings';
import { postingMatchesAnyRole } from '../lib/role-taxonomy';
import { classifyLocation } from './iso-locations';

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
  if (f.tierFilter === 'elite' && !isElite(i.company ?? '')) return false;
  if (f.tierFilter === 'top-or-better' && !isTopOrBetter(i.company ?? '')) return false;
  if (f.seasons.length > 0) {
    const tokens = i.season ?? parseSeason(i.title ?? '');
    if (!tokens.some(t => f.seasons.includes(t))) return false;
  }
  // User-engagement guards — defaults true. Rows in this function's input
  // are usually brand-new (newInternships from the current cycle, so
  // applied/hidden are false), but the guards cover edge cases where a
  // posting gets re-emitted under a fresh id after the user has acted on
  // a sibling row.
  if (f.skipApplied && i.applied) return false;
  if (f.skipHidden && i.hidden) return false;
  // Source blocklist — match against the discovery source.
  if (f.excludedSources.length > 0 && i.source && f.excludedSources.includes(i.source)) {
    return false;
  }
  // Non-US gate — uses the structured classifier. 'unknown' (unstructured
  // strings like "Remote" or "NYC") passes through; only definitive
  // non-US classifications are filtered.
  if (f.excludeNonUS && classifyLocation(i.location || '') === 'non_us') {
    return false;
  }
  // Keyword gates — match against the scorer's matchedKeywords (same
  // semantics as the app FilterRail). Case-insensitive set membership.
  const kws = (i.matchedKeywords ?? []).map(k => k.toLowerCase());
  if (f.includeKeywords.length > 0) {
    const need = f.includeKeywords.map(k => k.toLowerCase());
    if (!need.some(k => kws.includes(k))) return false;
  }
  if (f.excludeKeywords.length > 0) {
    const ban = f.excludeKeywords.map(k => k.toLowerCase());
    if (ban.some(k => kws.includes(k))) return false;
  }
  // Role gate — OR-semantics within Role (passes if posting matches ANY
  // selected role). Empty roles → no gate. Same matcher the app FilterRail
  // uses, so notifications and the UI stay consistent.
  if (f.roles && f.roles.length > 0) {
    if (!postingMatchesAnyRole(i.matchedKeywords ?? [], f.roles)) return false;
  }
  return true;
}

export async function sendBatchAlert(
  newInternships: Internship[],
  scoreThresholdFallback: number
): Promise<boolean> {
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
    return false;
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

  for (const posting of live) {
    const color = posting.scoreLabel === 'A' ? 0x00ff88 : 0x5865f2;
    const sourceEmoji = SOURCE_EMOJIS[posting.source] ?? '';
    // Discord message-component fields:
    //   - LINK buttons (style 5) need `url`, no custom_id, no callback.
    //   - PRIMARY/SECONDARY/DANGER buttons (1/2/4) need a custom_id; clicking
    //     them POSTs to our /api/discord/interactions endpoint.
    const fields = [
      { name: 'Score', value: `${posting.scoreLabel} (${posting.score ?? 0})`, inline: true },
      { name: 'Location', value: posting.location || 'Unknown', inline: true },
      { name: 'Source', value: posting.source || 'Unknown', inline: true },
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
            // Emoji-only buttons keep the action row narrow enough to fit on
            // one mobile row. Discord renders `emoji` without `label` as a
            // compact square button.
            {
              type: 2,
              style: 3, // SUCCESS (green)
              emoji: { name: '✅' },
              custom_id: `applied:${posting.id}`,
            },
            {
              type: 2,
              style: 4, // DANGER (red)
              emoji: { name: '❌' },
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

// ---------------------------------------------------------------------------
// Source-down detection + alerts
// ---------------------------------------------------------------------------

const ALERT_STATE_PATH = path.join(process.cwd(), 'data', 'source-alerts.json');
const SOURCE_FETCH_HISTORY_PATH = path.join(process.cwd(), 'data', 'source-fetch-history.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function loadSourceFetchHistory(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SOURCE_FETCH_HISTORY_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

interface AlertState {
  // Map of source name → ISO timestamp when we alerted for this outage.
  alertedSources: Record<string, string>;
}

function loadAlertState(): AlertState {
  try {
    return { alertedSources: {}, ...JSON.parse(fs.readFileSync(ALERT_STATE_PATH, 'utf-8')) };
  } catch {
    return { alertedSources: {} };
  }
}

function saveAlertState(state: AlertState): void {
  fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2));
}

async function postDiscordMessage(content: string): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_INTERNSHIPS;
  if (!token || !channelId) return false;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
      body: JSON.stringify({ content }),
    });
    return res.ok;
  } catch (err) {
    console.error('[notifier] source-alert post failed:', err);
    return false;
  }
}

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
  const history = loadSourceFetchHistory();

  const state = loadAlertState();
  const downNow: string[] = [];
  const recoveredNow: string[] = [];

  // Only evaluate sources we have any history for — a source we've never
  // successfully fetched isn't "down", it's "not configured".
  for (const [source, lastIso] of Object.entries(history)) {
    const age = now - new Date(lastIso).getTime();
    // Down only if quiet for 24h but had a successful fetch in the last 7d.
    // Anything stale > 7d → don't alert (probably retired/disabled source).
    const isDown = age > DAY_MS && age <= WEEK_MS;
    const alreadyAlerted = !!state.alertedSources[source];
    if (isDown && !alreadyAlerted) {
      downNow.push(source);
      state.alertedSources[source] = new Date().toISOString();
    } else if (!isDown && alreadyAlerted) {
      recoveredNow.push(source);
      delete state.alertedSources[source];
    }
  }

  if (downNow.length === 0 && recoveredNow.length === 0) return;

  if (downNow.length > 0) {
    const msg = `⚠️ **Source(s) quiet for 24h+**: ${downNow.join(', ')}\nNo new records since the last cycle — check the poller logs.`;
    await postDiscordMessage(msg);
  }
  if (recoveredNow.length > 0) {
    const msg = `✅ **Source(s) back online**: ${recoveredNow.join(', ')}`;
    await postDiscordMessage(msg);
  }

  saveAlertState(state);
}

