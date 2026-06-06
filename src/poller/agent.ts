import { Internship, CycleStats } from '../lib/types';
import { jsonStore } from '../lib/sidecar';
import { pollGitHub } from './pollers/github';
import { pollHandshake } from './pollers/handshake';
import { pollJobSpy } from './pollers/jobspy';
import { scanPortals } from './pollers/portal-scanner';
import { pollYCWaaS } from './pollers/yc-waas';
import { filterInternships } from './filter';
import { deduplicateAndStore, savePollStats } from '../lib/store';
import { enrichForStorage } from './utils/enrich';
import { sendBatchAlert, checkAndAlertSourceHealth } from './notifier';

export type CycleTier = 'fast' | 'slow' | 'all';

// Per-source last-successful-fetch timestamps. Sidecar file (not poll-stats.json
// because that lives behind store.ts and we want this independent of stored
// rows). Source-down detection reads this — keying off seenAt is wrong because
// cross-source dedup bumps seenAt on rediscovery, masking quiet sources.
//
// Schema: { [source]: ISO timestamp of last successful fetch }
const sourceFetchHistoryStore = jsonStore<Record<string, string>>(
  'source-fetch-history.json',
  {},
);

async function pollFastSources(
  stats: CycleStats,
  allRaw: Partial<Internship>[],
  fetched: Set<string>,
): Promise<void> {
  // Fast tier — sources that finish in seconds and refresh often.
  // SimplifyJobs RSS is the only one in this tier today (~10s total).
  try {
    const githubResults = await pollGitHub();
    allRaw.push(...githubResults);
    stats.sourcesPolled.push('SimplifyJobs');
    fetched.add('SimplifyJobs');
  } catch (err: any) {
    console.error('[agent] GitHub poller failed:', err.message);
  }
}

async function pollSlowSources(
  stats: CycleStats,
  allRaw: Partial<Internship>[],
  fetched: Set<string>,
): Promise<void> {
  // Slow tier runs three lanes in parallel:
  //   1. HTTP lane (pure JSON/HTTP, no headless browsers) — parallel within
  //   2. Playwright lane (one browser at a time to cap memory) — serial within
  //   3. JobSpy lane (spawns a Python subprocess) — one-shot
  // Lanes themselves run concurrently. Playwright is the memory hog so we
  // never run >1 of those at once; everything else can stack.

  const httpLane = async (): Promise<void> => {
    // Each task here runs in parallel — they hit different hosts, no contention.
    await Promise.allSettled([
      (async () => {
        try {
          const { listings, archivedByTarget } = await scanPortals();
          allRaw.push(...listings);
          const srcs = [...new Set(listings.map(r => r.source).filter(Boolean))] as string[];
          stats.sourcesPolled.push(...srcs.filter(s => !stats.sourcesPolled.includes(s)));
          // scanPortals returning without throwing = ATS HTTP layer is alive.
          // Record all known ATS sources as fetched even when they returned 0
          // listings (a portal with no current interns is still healthy).
          for (const src of ['Greenhouse', 'Lever', 'Ashby', 'Workday', 'iCIMS', 'SmartRecruiters']) {
            fetched.add(src);
          }
          for (const [target, count] of Object.entries(archivedByTarget)) {
            console.log(`[agent] ATS portal ${target}: ${count} listing(s) disappeared and were archived`);
          }
        } catch (err: any) {
          console.error('[agent] ATS poller failed:', err.message);
        }
      })(),
    ]);
  };

  const playwrightLane = async (): Promise<void> => {
    // Strictly serial — each poller opens its own Chromium/Firefox instance and
    // running two browsers at once will OOM the Railway container (~500MB-1GB each).
    try {
      const r = await pollHandshake();
      allRaw.push(...r);
      if (r.length > 0) stats.sourcesPolled.push('Handshake');
      fetched.add('Handshake');
    } catch (err: any) {
      console.error('[agent] Handshake poller failed:', err.message);
    }
    try {
      const r = await pollYCWaaS();
      allRaw.push(...r);
      if (r.length > 0) stats.sourcesPolled.push('YC WaaS');
      fetched.add('YC WaaS');
    } catch (err: any) {
      console.error('[agent] YC WaaS poller failed:', err.message);
    }
  };

  const jobspyLane = async (): Promise<void> => {
    try {
      const r = await pollJobSpy();
      allRaw.push(...r);
      const srcs = [...new Set(r.map(j => j.source).filter(Boolean))] as string[];
      stats.sourcesPolled.push(...srcs.filter(s => !stats.sourcesPolled.includes(s)));
      // JobSpy spans several sub-sources (Indeed, LinkedIn, Glassdoor, ZipRecruiter)
      // and one missing doesn't mean the whole subprocess failed. Record each one
      // we got back as alive; the rest will appear quiet only if they're truly down.
      for (const s of srcs) fetched.add(s);
    } catch (err: any) {
      console.error('[agent] JobSpy poller failed:', err.message);
    }
  };

  await Promise.allSettled([httpLane(), playwrightLane(), jobspyLane()]);
}

export async function runCycle(opts: { tier?: CycleTier } = {}): Promise<CycleStats> {
  const tier = opts.tier ?? 'all';
  const stats: CycleStats = {
    timestamp: new Date().toISOString(),
    sourcesPolled: [],
    rawFetched: 0,
    excludedNonUS: 0,
    excludedPhDRequired: 0,
    excludedClosed: 0,
    excludedNonSWE: 0,
    newScored: 0,
    sent: 0,
  };

  const allRaw: Partial<Internship>[] = [];
  // Per-source successful-fetch tracker. A "fetch" succeeds when the poller's
  // HTTP/browser call returned a parseable response — even if zero internships
  // came back. This is the right signal for source-health alerts.
  const fetched = new Set<string>();

  console.log(`[agent] Starting ${tier} cycle`);
  if (tier === 'fast' || tier === 'all') await pollFastSources(stats, allRaw, fetched);
  if (tier === 'slow' || tier === 'all') await pollSlowSources(stats, allRaw, fetched);

  // Persist per-source last-fetch-at to the sidecar. checkAndAlertSourceHealth
  // reads this to decide which sources have actually gone quiet vs. just had
  // a slow week. Merge with prior history so a partial cycle (fast only)
  // doesn't blank out slow-source timestamps.
  if (fetched.size > 0) {
    const history = sourceFetchHistoryStore.load();
    const nowIso = new Date().toISOString();
    for (const src of fetched) history[src] = nowIso;
    sourceFetchHistoryStore.save(history);
  }

  stats.rawFetched = allRaw.length;
  console.log(`[agent] Fetched ${stats.rawFetched} raw postings from ${stats.sourcesPolled.join(', ')}`);

  // Apply hard filters
  const { passed, counts } = filterInternships(allRaw);
  stats.excludedNonUS = counts.excludedNonUS;
  stats.excludedPhDRequired = counts.excludedPhDRequired;
  stats.excludedClosed = counts.excludedClosed;
  stats.excludedNonSWE = counts.excludedNonSWE;

  // Compute per-source breakdown from raw fetch (before filtering)
  const sourceCounts: Record<string, number> = {};
  for (const i of allRaw) {
    const src = i.source || 'Unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }

  const totalExcluded = stats.rawFetched - passed.length;
  console.log(`[agent] Filtered: ${passed.length} passed, ${totalExcluded} excluded (nonUS:${stats.excludedNonUS}, phd:${stats.excludedPhDRequired}, closed:${stats.excludedClosed}, nonSWE:${stats.excludedNonSWE})`);

  // Score + dehydrate each filtered row. Single `now` shared across the batch
  // so per-cycle seenAt is identical for every row inserted this cycle.
  const now = new Date().toISOString();
  const scored: Internship[] = passed.map((p) => enrichForStorage(p, now));

  // Dedup and store
  const { newInternships, totalStored, netNewBySource } = await deduplicateAndStore(scored);
  stats.newScored = newInternships.length;
  console.log(`[agent] ${newInternships.length} new postings stored (total: ${totalStored})`);

  // Log per-source net-new contribution so we can see which sources are
  // actually pulling weight vs. always deduping against existing rows.
  const netNewSummary = Object.entries(netNewBySource)
    .sort(([, a], [, b]) => b - a)
    .map(([s, n]) => `${s}=${n}`)
    .join(' ');
  if (netNewSummary) console.log(`[agent] Net-new by source: ${netNewSummary}`);

  // Persist exclusion counts + per-source net-new so the stats API can surface them
  savePollStats({
    polledAt: new Date().toISOString(),
    sourceCounts,
    netNewBySource,
    exclusionCounts: {
      'non-us':         counts.excludedNonUS,
      'phd-required':   counts.excludedPhDRequired,
      'closed':         counts.excludedClosed,
      'non-swe':        counts.excludedNonSWE,
      'not-intern':     counts.excludedNotIntern,
      'expired-season': counts.excludedExpiredSeason,
    },
  });

  // Send notifications. notif-settings.json (user-edited in the UI) is the
  // source of truth for minScore; SCORE_THRESHOLD env is the legacy fallback.
  const envThreshold = parseInt(process.env.SCORE_THRESHOLD || '50', 10);
  if (newInternships.length > 0) {
    // stats.sent now reflects postings that actually went out — the notifier
    // also drops on tier/season/dead-link filters, so the old caller-side
    // "rows above scoreThreshold" overreported.
    const { sentCount } = await sendBatchAlert(newInternships, envThreshold);
    stats.sent = sentCount;
  }

  // Source-down detection — only after a full cycle (tier === 'all' or 'slow')
  // since the fast cycle only hits SimplifyJobs and shouldn't trigger alerts on
  // sources that weren't polled this round.
  if (opts.tier !== 'fast') {
    await checkAndAlertSourceHealth().catch(err =>
      console.error('[agent] source-health alert check failed:', err),
    );
  }

  logCycleStats(stats);
  return stats;
}

function logCycleStats(stats: CycleStats): void {
  console.log('[cycle stats]', JSON.stringify({
    timestamp: stats.timestamp,
    sourcesPolled: stats.sourcesPolled,
    rawFetched: stats.rawFetched,
    excluded: {
      nonUS: stats.excludedNonUS,
      phdRequired: stats.excludedPhDRequired,
      closed: stats.excludedClosed,
      nonSWE: stats.excludedNonSWE,
    },
    newScored: stats.newScored,
    sent: stats.sent,
  }, null, 2));
}
