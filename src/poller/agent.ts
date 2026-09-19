import type { RawPosting, ATSTarget } from '../lib/types';
import { pollGitHub } from './pollers/github';
import { pollJobSpy } from './pollers/jobspy';
import { pollATS, STARTUP_ATS, ENTERPRISE_ATS } from './pollers/ats';
import { ATS } from './ats';
import { pollYCWaaS } from './pollers/yc-waas';
import { filterPostings } from './filter';
import { deduplicateAndStore, savePollStats } from '../lib/store';
import { enrichForStorage } from './utils/enrich';
import { sendBatchAlert, checkAndAlertSourceHealth, recordSourceFetches } from './notifier';
import { classifyRows } from './classify';

export type CycleTier = 'fast' | 'slow' | 'all';

interface SourceRun {
  label: string;
  poll: () => Promise<RawPosting[]>;
  /** Source names to mark as fetched when the poll returns without throwing,
   *  even with zero rows. Defaults to the sources present in the result. */
  sources?: readonly string[];
}

const sourcesFor = (kinds: ReadonlySet<ATSTarget['ats']>) => [...kinds].map(k => ATS[k].source);

// Fast tier: the SimplifyJobs README and every startup board, both a minute
// or two per run, polled every 15 minutes so a new posting is seen early.
const FAST: SourceRun[] = [
  { label: 'SimplifyJobs', poll: pollGitHub, sources: ['SimplifyJobs'] },
  { label: 'Startup boards', poll: () => pollATS(STARTUP_ATS), sources: sourcesFor(STARTUP_ATS) },
];

// Slow tier: enterprise ATSes and YC over HTTP in parallel, JobSpy (a Python
// subprocess scraping LinkedIn) alongside.
const SLOW_HTTP: SourceRun[] = [
  { label: 'Enterprise boards', poll: () => pollATS(ENTERPRISE_ATS), sources: sourcesFor(ENTERPRISE_ATS) },
  { label: 'YC WaaS', poll: pollYCWaaS, sources: ['YC WaaS'] },
];
const SLOW_SUBPROCESS: SourceRun[] = [
  // Only the JobSpy sub-sources that returned rows count as fetched.
  { label: 'JobSpy', poll: pollJobSpy },
];

interface Collected {
  raw: RawPosting[];
  fetched: Set<string>;
}

// Log start and finish per source so a hang names its culprit in the logs.
async function runSource(run: SourceRun, into: Collected): Promise<void> {
  const startedAt = Date.now();
  console.log(`[agent] ${run.label}: started`);
  try {
    const rows = await run.poll();
    into.raw.push(...rows);
    for (const s of run.sources ?? rows.map(r => r.source)) into.fetched.add(s);
  } catch (err) {
    console.error(`[agent] ${run.label} failed:`, err instanceof Error ? err.message : err);
  } finally {
    console.log(`[agent] ${run.label}: finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
}

async function runSerial(runs: SourceRun[], into: Collected): Promise<void> {
  for (const run of runs) await runSource(run, into);
}

export async function runCycle(tier: CycleTier = 'all'): Promise<void> {
  console.log(`[agent] Starting ${tier} cycle`);
  const collected: Collected = { raw: [], fetched: new Set() };

  if (tier !== 'slow') await Promise.all(FAST.map(run => runSource(run, collected)));
  if (tier !== 'fast') {
    await Promise.all([
      Promise.all(SLOW_HTTP.map(run => runSource(run, collected))),
      runSerial(SLOW_SUBPROCESS, collected),
    ]);
  }

  const { raw, fetched } = collected;
  if (fetched.size > 0) await recordSourceFetches(fetched);
  console.log(`[agent] Fetched ${raw.length} raw postings from ${[...fetched].join(', ')}`);

  const { passed, excluded } = filterPostings(raw);
  console.log(`[agent] Filtered: ${passed.length} passed, ${raw.length - passed.length} excluded ${JSON.stringify(excluded)}`);

  const now = new Date().toISOString();
  const { newInternships, totalStored, netNewBySource } = await deduplicateAndStore(passed.map(p => enrichForStorage(p, now)));
  console.log(`[agent] ${newInternships.length} new postings stored (total: ${totalStored})`);
  if (newInternships.length > 0) {
    console.log(`[agent] Net-new by source: ${Object.entries(netNewBySource).map(([s, n]) => `${s}=${n}`).join(' ')}`);
  }

  const sourceCounts: Record<string, number> = {};
  for (const r of raw) sourceCounts[r.source] = (sourceCounts[r.source] ?? 0) + 1;
  await savePollStats({ polledAt: now, sourceCounts, netNewBySource });

  if (newInternships.length > 0) {
    // Classify before notifying so the alert carries the judged score and
    // non-technical or non-US rows never reach Discord.
    const { kept } = await classifyRows(newInternships);
    const sent = await sendBatchAlert(kept);
    console.log(`[agent] Notified ${sent} posting(s)`);
  }

  // Only a full cycle can judge every source's liveness.
  if (tier !== 'fast') {
    await checkAndAlertSourceHealth().catch(err => console.error('[agent] source-health check failed:', err));
  }
}
