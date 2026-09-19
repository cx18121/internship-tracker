import 'dotenv/config';
import { runCycle } from './agent';
import { closePool } from '../lib/db';
import { runMigrations } from '../lib/migrate';
import { backfillJobKeys } from '../lib/store';
import { reevaluate } from './reevaluate';
import { withTimeout, TimeoutError } from './utils/with-timeout';

// Two-tier polling:
//   Fast tier (default 15 min) — SimplifyJobs only. Seconds per run.
//   Slow tier (default 60 min) — ATS sweeps, JobSpy (LinkedIn), YC WaaS.
//                                 Minutes per run; the dominant compute cost.
const POLL_INTERVAL_MS_FAST = parseInt(process.env.POLL_INTERVAL_MS_FAST || '900000', 10);
const POLL_INTERVAL_MS_SLOW = parseInt(process.env.POLL_INTERVAL_MS_SLOW || '3600000', 10);
const REVALIDATE_INTERVAL_MS = parseInt(process.env.REVALIDATE_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);

// Nightly quiet window: postings rarely appear overnight and the slow tier is
// the compute cost, so both tiers pause. [start, end) hours in POLL_TZ, may
// wrap midnight ("22-6"). Set POLL_QUIET_HOURS="" to disable.
const POLL_TZ = process.env.POLL_TZ || 'America/New_York';
const QUIET_WINDOW = ((): [number, number] | null => {
  const spec = process.env.POLL_QUIET_HOURS ?? '1-7';
  const m = spec.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (start > 23 || end > 23) return null;
  return [start, end];
})();

function inQuietHours(): boolean {
  if (!QUIET_WINDOW) return false;
  const [start, end] = QUIET_WINDOW;
  const h = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: POLL_TZ }).format(new Date()),
    10,
  ) % 24;
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

// Per-cycle watchdog deadlines. A healthy slow cycle runs in minutes (JobSpy
// alone can take up to 5); these sit well above worst-case so they only trip on
// a genuine wedge — an upstream op that hangs with no internal timeout. The
// per-op timeouts inside the pollers (Playwright's ~30s defaults, axios
// timeouts, JobSpy's subprocess kill, our page.evaluate wrappers) should catch
// hangs first; this is the coarse backstop for anything that slips through.
const WATCHDOG_MS_FAST = parseInt(process.env.WATCHDOG_MS_FAST || String(5 * 60 * 1000), 10);
const WATCHDOG_MS_SLOW = parseInt(process.env.WATCHDOG_MS_SLOW || String(20 * 60 * 1000), 10);
const WATCHDOG_MS_INITIAL = parseInt(process.env.WATCHDOG_MS_INITIAL || String(25 * 60 * 1000), 10);
const WATCHDOG_MS_REVALIDATE = parseInt(process.env.WATCHDOG_MS_REVALIDATE || String(30 * 60 * 1000), 10);

function msUntilNextBoundary(intervalMs: number): number {
  const now = Date.now();
  return Math.ceil(now / intervalMs) * intervalMs - now;
}

// In-process lock so a long slow cycle doesn't get layered on top of itself
// while fast cycles continue. Fast cycles still run during slow cycles —
// they hit different sources and the store has its own write lock.
let slowRunning = false;

// Run `work` under a watchdog. An ordinary failure propagates to the caller.
// A timeout means something hung with no internal timeout (a wedged browser,
// a stuck page.evaluate). The hung op may still hold a Firefox process, and
// stacking another cycle on top leaks browsers until the container OOMs, so
// exit non-zero and let the supervisor restart the process clean.
async function withWatchdog<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  try {
    return await withTimeout(work, ms, label);
  } catch (err) {
    if (err instanceof TimeoutError) {
      console.error(
        `[internship-tracker] WATCHDOG: ${err.message} — cycle wedged with no ` +
        `internal timeout; exiting for a clean supervisor restart`,
      );
      try { await closePool(); } catch {}
      process.exit(1);
    }
    throw err;
  }
}

async function safeSlow(): Promise<void> {
  if (inQuietHours()) {
    console.log('[internship-tracker] Quiet hours — skipping slow cycle');
    return;
  }
  if (slowRunning) {
    console.log('[internship-tracker] Slow cycle already in flight — skipping this tick');
    return;
  }
  slowRunning = true;
  try {
    await withWatchdog('slow cycle', WATCHDOG_MS_SLOW, runCycle('slow'));
  } catch (err) {
    // Never let a single bad cycle propagate out of setInterval — that would
    // raise an unhandledRejection and (on newer Node) kill the process.
    console.error('[internship-tracker] Slow cycle threw:', err);
  } finally {
    slowRunning = false;
  }
}

async function safeFast(): Promise<void> {
  if (inQuietHours()) return;
  try {
    await withWatchdog('fast cycle', WATCHDOG_MS_FAST, runCycle('fast'));
  } catch (err) {
    console.error('[internship-tracker] Fast cycle threw:', err);
  }
}

async function safeRevalidate(): Promise<void> {
  try {
    await withWatchdog('re-evaluation', WATCHDOG_MS_REVALIDATE, reevaluate());
  } catch (err) {
    console.error('[internship-tracker] Re-evaluation threw:', err);
  }
}

async function main(): Promise<void> {
  console.log(`[internship-tracker] Starting agent.`);
  console.log(`[internship-tracker] Fast poll: ${POLL_INTERVAL_MS_FAST / 1000}s | Slow poll: ${POLL_INTERVAL_MS_SLOW / 1000}s`);
  console.log(`[internship-tracker] Revalidate: ${REVALIDATE_INTERVAL_MS / 1000 / 60 / 60}h`);
  console.log(`[internship-tracker] Quiet hours: ${QUIET_WINDOW ? `${QUIET_WINDOW[0]}:00–${QUIET_WINDOW[1]}:00 ${POLL_TZ}` : 'disabled'}`);
  await runMigrations();
  const filled = await backfillJobKeys();
  if (filled > 0) console.log(`[poller] job_key backfilled on ${filled} rows`);

  // Initial run — do everything once so the DB has fresh state.
  // Wrapped so a transient startup failure (single source 500, DNS hiccup,
  // etc.) just logs and continues to the interval setup, rather than killing
  // the supervisor before any poll cycle is ever scheduled.
  try {
    await withWatchdog('initial cycle', WATCHDOG_MS_INITIAL, runCycle('all'));
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
  try { await closePool(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(async err => {
  console.error('[internship-tracker] Fatal error:', err);
  try { await closePool(); } catch {}
  process.exit(1);
});
