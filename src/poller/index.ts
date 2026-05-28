import 'dotenv/config';
import { runCycle } from './agent';
import { revalidateLinks, closeDb } from '../lib/store';
import { revalidateLinkedIn } from './linkedin-revalidate';

// Two-tier polling:
//   Fast tier (default 15 min) — SimplifyJobs RSS only. Quick to fetch, high
//                                 signal, refreshed often.
//   Slow tier (default 60 min) — Handshake, ATS sweeps, JobSpy, YC WaaS.
//                                 Minutes per run.
// Defaults stretched from 5/30 → 15/60 min in 2026-05 to cut Railway compute
// cost roughly in half. For a personal tracker, a 15-minute lag on new
// postings is fine, and the slow cycle is the dominant cost driver anyway.
// Override with POLL_INTERVAL_MS_FAST / POLL_INTERVAL_MS_SLOW env vars.
// POLL_INTERVAL_MS stays as a backwards-compatible alias — if set, it
// overrides the slow-tier interval (the old single-tier behaviour).
const POLL_INTERVAL_MS_FAST = parseInt(process.env.POLL_INTERVAL_MS_FAST || '900000', 10);
const POLL_INTERVAL_MS_SLOW = parseInt(
  process.env.POLL_INTERVAL_MS_SLOW || process.env.POLL_INTERVAL_MS || '3600000',
  10,
);
const REVALIDATE_INTERVAL_MS = parseInt(process.env.REVALIDATE_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);

function msUntilNextBoundary(intervalMs: number): number {
  const now = Date.now();
  return Math.ceil(now / intervalMs) * intervalMs - now;
}

// In-process lock so a long slow cycle doesn't get layered on top of itself
// while fast cycles continue. Fast cycles still run during slow cycles —
// they hit different sources and the store has its own write lock.
let slowRunning = false;

async function safeSlow(): Promise<void> {
  if (slowRunning) {
    console.log('[internship-tracker] Slow cycle already in flight — skipping this tick');
    return;
  }
  slowRunning = true;
  try {
    await runCycle({ tier: 'slow' });
  } catch (err) {
    // Never let a single bad cycle propagate out of setInterval — that would
    // raise an unhandledRejection and (on newer Node) kill the process.
    console.error('[internship-tracker] Slow cycle threw:', err);
  } finally {
    slowRunning = false;
  }
}

async function safeFast(): Promise<void> {
  try {
    await runCycle({ tier: 'fast' });
  } catch (err) {
    console.error('[internship-tracker] Fast cycle threw:', err);
  }
}

async function safeRevalidate(): Promise<void> {
  try {
    await revalidateLinks();
  } catch (err) {
    console.error('[internship-tracker] Link revalidation threw:', err);
  }
  // LinkedIn returns HTTP 200 for closed jobs, so it slips past the HEAD-check
  // pass above. Run the content-based sweep on the same daily cadence to keep
  // the LinkedIn corpus from accumulating stale entries.
  try {
    await revalidateLinkedIn();
  } catch (err) {
    console.error('[internship-tracker] LinkedIn revalidation threw:', err);
  }
}

async function main(): Promise<void> {
  console.log(`[internship-tracker] Starting agent.`);
  console.log(`[internship-tracker] Fast poll: ${POLL_INTERVAL_MS_FAST / 1000}s | Slow poll: ${POLL_INTERVAL_MS_SLOW / 1000}s`);
  console.log(`[internship-tracker] Revalidate: ${REVALIDATE_INTERVAL_MS / 1000 / 60 / 60}h | Score threshold: ${process.env.SCORE_THRESHOLD || '50'}`);

  // Initial run — do everything once so the DB has fresh state.
  // Wrapped so a transient startup failure (single source 500, DNS hiccup,
  // etc.) just logs and continues to the interval setup, rather than killing
  // the supervisor before any poll cycle is ever scheduled.
  try {
    await runCycle({ tier: 'all' });
  } catch (err) {
    console.error('[internship-tracker] Initial cycle threw:', err);
  }

  // Daily revalidation
  const revMs = msUntilNextBoundary(REVALIDATE_INTERVAL_MS);
  const nextRev = new Date(Date.now() + revMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  console.log(`[internship-tracker] First revalidation at ${nextRev} (in ${Math.round(revMs / 1000 / 60)}min)`);
  setTimeout(async () => {
    console.log('[internship-tracker] Running daily link revalidation...');
    await safeRevalidate();
    setInterval(() => {
      console.log('[internship-tracker] Running daily link revalidation...');
      safeRevalidate();
    }, REVALIDATE_INTERVAL_MS);
  }, revMs);

  // Fast cycle — kick off on the next boundary and repeat every POLL_INTERVAL_MS_FAST
  const fastDelay = msUntilNextBoundary(POLL_INTERVAL_MS_FAST);
  const fastFirst = new Date(Date.now() + fastDelay).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  console.log(`[internship-tracker] First fast cycle at ${fastFirst} (in ${Math.round(fastDelay / 1000)}s)`);
  setTimeout(() => {
    safeFast();
    setInterval(safeFast, POLL_INTERVAL_MS_FAST);
  }, fastDelay);

  // Slow cycle — same pattern, longer cadence
  const slowDelay = msUntilNextBoundary(POLL_INTERVAL_MS_SLOW);
  const slowFirst = new Date(Date.now() + slowDelay).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  console.log(`[internship-tracker] First slow cycle at ${slowFirst} (in ${Math.round(slowDelay / 1000)}s)`);
  setTimeout(() => {
    safeSlow();
    setInterval(safeSlow, POLL_INTERVAL_MS_SLOW);
  }, slowDelay);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Railway sends SIGTERM during deploys and gives ~10s before SIGKILL. We don't
// try to wait for an in-flight cycle to finish (slow cycles take minutes) —
// anything mid-transaction either COMMITted or will be re-fetched next cycle.
// We just drain the pg pool so open connections close cleanly, then exit 0.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[internship-tracker] Received ${signal} — closing pool and exiting cleanly`);
  try { await closeDb(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(async err => {
  console.error('[internship-tracker] Fatal error:', err);
  try { await closeDb(); } catch {}
  process.exit(1);
});
