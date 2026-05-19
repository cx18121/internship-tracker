import 'dotenv/config';
import { runCycle } from './agent';
import { archiveStalePostings, revalidateLinks, closeDb } from '../lib/store';

// Two-tier polling:
//   Fast tier (default 5 min)  — SimplifyJobs RSS only. Quick to fetch, high
//                                 signal, refreshed often.
//   Slow tier (default 30 min) — Handshake, ATS sweeps, JobSpy, in-house,
//                                 careers-scan, YC, discovery. Minutes per run.
// POLL_INTERVAL_MS stays as a backwards-compatible alias — if set, it
// overrides the slow-tier interval (the old single-tier behaviour).
const POLL_INTERVAL_MS_FAST = parseInt(process.env.POLL_INTERVAL_MS_FAST || '300000', 10);
const POLL_INTERVAL_MS_SLOW = parseInt(
  process.env.POLL_INTERVAL_MS_SLOW || process.env.POLL_INTERVAL_MS || '1800000',
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
    archiveStalePostings();
    await runCycle({ tier: 'slow' });
  } finally {
    slowRunning = false;
  }
}

async function safeFast(): Promise<void> {
  await runCycle({ tier: 'fast' });
}

async function main(): Promise<void> {
  console.log(`[internship-tracker] Starting agent.`);
  console.log(`[internship-tracker] Fast poll: ${POLL_INTERVAL_MS_FAST / 1000}s | Slow poll: ${POLL_INTERVAL_MS_SLOW / 1000}s`);
  console.log(`[internship-tracker] Revalidate: ${REVALIDATE_INTERVAL_MS / 1000 / 60 / 60}h | Score threshold: ${process.env.SCORE_THRESHOLD || '50'}`);

  // Initial run — do everything once so the DB has fresh state.
  archiveStalePostings();
  await runCycle({ tier: 'all' });

  // Daily revalidation
  const revMs = msUntilNextBoundary(REVALIDATE_INTERVAL_MS);
  const nextRev = new Date(Date.now() + revMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  console.log(`[internship-tracker] First revalidation at ${nextRev} (in ${Math.round(revMs / 1000 / 60)}min)`);
  setTimeout(async () => {
    console.log('[internship-tracker] Running daily link revalidation...');
    await revalidateLinks();
    setInterval(async () => {
      console.log('[internship-tracker] Running daily link revalidation...');
      await revalidateLinks();
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
// SQLite writes are synchronous, so anything mid-cycle has either committed or
// will be re-fetched next cycle. We just close the DB cleanly so WAL gets
// checkpointed, then exit 0 to keep the supervisor quiet.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[internship-tracker] Received ${signal} — closing DB and exiting cleanly`);
  try { closeDb(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(err => {
  console.error('[internship-tracker] Fatal error:', err);
  closeDb();
  process.exit(1);
});
