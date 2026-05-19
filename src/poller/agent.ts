import md5 from 'md5';
import { Internship, CycleStats } from '../lib/types';
import { stripUtm } from '../lib/utils/normalize';
import { pollGitHub } from './pollers/github';
import { pollHandshake } from './pollers/handshake';
import { pollJobSpy } from './pollers/jobspy';
import { scanPortals } from './pollers/portal-scanner';
import { pollYCWaaS } from './pollers/yc-waas';
import { pollInhouse } from './pollers/inhouse';
import { pollGreenhouseDiscovery } from './pollers/greenhouse';
import { pollLeverDiscovery } from './pollers/lever';
import { pollAshbyDiscovery } from './pollers/ashby';
import { pollWebsearchDiscovery } from './pollers/websearch-discovery';
import { scanCareersPages } from './pollers/careers-scan';
import { filterInternships } from './filter';
import { scoreInternship } from '../lib/scorer';
import { deduplicateAndStore, savePollStats } from '../lib/store';
import { sendBatchAlert, sendSourceFailureAlert, recordSourceFailure, recordSourceSuccess } from './notifier';

let consecutiveFailures = 0;

export async function runCycle(): Promise<CycleStats> {
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

  // Poll GitHub (SimplifyJobs)
  try {
    const githubResults = await pollGitHub();
    allRaw.push(...githubResults);
    stats.sourcesPolled.push('SimplifyJobs');
    recordSourceSuccess();
    consecutiveFailures = 0;
  } catch (err: any) {
    console.error('[agent] GitHub poller failed:', err.message);
    recordSourceFailure();
    consecutiveFailures++;
  }

  // Poll Handshake
  try {
    const handshakeResults = await pollHandshake();
    allRaw.push(...handshakeResults);
    if (handshakeResults.length > 0) {
      stats.sourcesPolled.push('Handshake');
      recordSourceSuccess();
    }
  } catch (err: any) {
    console.error('[agent] Handshake poller failed:', err.message);
    recordSourceFailure();
    consecutiveFailures++;
  }

  // Poll ATS APIs (Greenhouse, Lever, Ashby) — fast, direct JSON
  try {
    const { listings: atsResults, archivedByTarget } = await scanPortals();
    allRaw.push(...atsResults);
    const atsSources = [...new Set(atsResults.map(r => r.source).filter(Boolean))] as string[];
    stats.sourcesPolled.push(...atsSources.filter(s => !stats.sourcesPolled.includes(s)));
    for (const [target, count] of Object.entries(archivedByTarget)) {
      console.log(`[agent] ATS portal ${target}: ${count} listing(s) disappeared and were archived`);
    }
  } catch (err: any) {
    console.error('[agent] ATS poller failed:', err.message);
  }

  // Poll Greenhouse public boards (seed-based discovery)
  try {
    const ghResults = await pollGreenhouseDiscovery();
    allRaw.push(...ghResults);
    if (ghResults.length > 0) stats.sourcesPolled.push('Greenhouse');
  } catch (err: any) {
    console.error('[agent] Greenhouse discovery poller failed:', err.message);
  }

  // Poll Lever public boards (seed-based discovery)
  try {
    const leverResults = await pollLeverDiscovery();
    allRaw.push(...leverResults);
    if (leverResults.length > 0) stats.sourcesPolled.push('Lever');
  } catch (err: any) {
    console.error('[agent] Lever discovery poller failed:', err.message);
  }

  // Poll Ashby public boards (JSON API first, HTML scrape fallback)
  try {
    const ashbyResults = await pollAshbyDiscovery();
    allRaw.push(...ashbyResults);
    if (ashbyResults.length > 0) stats.sourcesPolled.push('Ashby');
  } catch (err: any) {
    console.error('[agent] Ashby discovery poller failed:', err.message);
  }

  // Grow company registry via WebSearch discovery (additive — does not collect listings)
  try {
    const websearchResults = await pollWebsearchDiscovery();
    if (websearchResults.length > 0) {
      stats.sourcesPolled.push('WebSearchDiscovery');
      console.log(`[agent] WebSearch discovery added ${websearchResults.length} new companies to registry`);
    }
  } catch (err: any) {
    console.error('[agent] WebSearch discovery poller failed:', err.message);
  }

  // Poll direct careers pages via Playwright (for companies not on Greenhouse/Lever/Ashby)
  try {
    const careersResults = await scanCareersPages();
    allRaw.push(...careersResults);
    if (careersResults.length > 0) stats.sourcesPolled.push('CareersScan');
  } catch (err: any) {
    console.error('[agent] Careers scan poller failed:', err.message);
  }

  // Poll YC Work at a Startup — intern postings from Y Combinator startups
  try {
    const ycResults = await pollYCWaaS();
    allRaw.push(...ycResults);
    if (ycResults.length > 0) {
      stats.sourcesPolled.push('YC WaaS');
    }
  } catch (err: any) {
    console.error('[agent] YC WaaS poller failed:', err.message);
  }

  // Poll in-house career pages (Netflix, Jane Street, Two Sigma, DE Shaw)
  try {
    const inhouseResults = await pollInhouse();
    allRaw.push(...inhouseResults);
    if (inhouseResults.length > 0) {
      stats.sourcesPolled.push('Inhouse');
    }
  } catch (err: any) {
    console.error('[agent] Inhouse poller failed:', err.message);
  }

  // Poll JobSpy (LinkedIn, Indeed, Glassdoor, Google Jobs) — runs last, slowest
  try {
    const jobspyResults = await pollJobSpy();
    allRaw.push(...jobspyResults);
    const jsSources = [...new Set(jobspyResults.map(r => r.source).filter(Boolean))] as string[];
    stats.sourcesPolled.push(...jsSources.filter(s => !stats.sourcesPolled.includes(s)));
  } catch (err: any) {
    console.error('[agent] JobSpy poller failed:', err.message);
  }

  stats.rawFetched = allRaw.length;
  console.log(`[agent] Fetched ${stats.rawFetched} raw postings from ${stats.sourcesPolled.join(', ')}`);

  // Check for consecutive source failures
  if (consecutiveFailures >= 2) {
    console.error('[agent] 2+ consecutive source failures — sending alert');
    await sendSourceFailureAlert();
    consecutiveFailures = 0;
  }

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

  // Score remaining postings
  const scored: Internship[] = passed.map(p => {
    const { score, scoreLabel, matchedKeywords } = scoreInternship(p);
    const id = md5(`${p.company || ''}${p.title || ''}${stripUtm(p.link || '')}`);
    return {
      id,
      title: p.title || '',
      company: p.company || '',
      location: p.location || '',
      link: p.link || '',
      source: p.source || 'Unknown',
      postedAt: p.postedAt || new Date().toISOString(),
      seenAt: new Date().toISOString(),
      score,
      scoreLabel,
      matchedKeywords,
      isNew: true,
      applied: false,
    };
  });

  // Dedup and store
  const { newInternships, totalStored } = await deduplicateAndStore(scored);
  stats.newScored = newInternships.length;
  console.log(`[agent] ${newInternships.length} new postings stored (total: ${totalStored})`);

  // Persist exclusion counts so the stats API can surface them
  savePollStats({
    polledAt: new Date().toISOString(),
    sourceCounts,
    exclusionCounts: {
      'non-us':         counts.excludedNonUS,
      'phd-required':   counts.excludedPhDRequired,
      'closed':         counts.excludedClosed,
      'non-swe':        counts.excludedNonSWE,
      'not-intern':     counts.excludedNotIntern,
    },
  });

  // Send notifications
  const scoreThreshold = parseInt(process.env.SCORE_THRESHOLD || '50', 10);
  if (newInternships.length > 0) {
    const sent = await sendBatchAlert(newInternships, scoreThreshold);
    if (sent) stats.sent = newInternships.filter(i => (i.score ?? 0) >= scoreThreshold).length;
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
