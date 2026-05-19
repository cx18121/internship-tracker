import 'dotenv/config';
import { runCycle } from './agent';
import { archiveStalePostings, revalidateLinks } from '../lib/store';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '900000', 10);
const REVALIDATE_INTERVAL_MS = parseInt(process.env.REVALIDATE_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10); // default: 24h

function msUntilNextBoundary(intervalMs: number): number {
  const now = Date.now();
  return Math.ceil(now / intervalMs) * intervalMs - now;
}

async function main(): Promise<void> {
  console.log(`[internship-tracker] Starting agent. Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[internship-tracker] Revalidate interval: ${REVALIDATE_INTERVAL_MS / 1000 / 60 / 60}h`);
  console.log(`[internship-tracker] Score threshold: ${process.env.SCORE_THRESHOLD || '50'}`);

  // --- Run first cycle and revalidation immediately on startup ---
  archiveStalePostings();
  await runCycle();

  // --- Run revalidation once on startup (daily boundary) ---
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

  // --- Poll cycle (15-min interval) ---
  const pollMs = msUntilNextBoundary(POLL_INTERVAL_MS);
  const nextPoll = new Date(Date.now() + pollMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  console.log(`[internship-tracker] First poll cycle at ${nextPoll} (in ${Math.round(pollMs / 1000)}s)`);
  setTimeout(async () => {
    archiveStalePostings();
    await runCycle();
    setInterval(async () => {
      archiveStalePostings();
      await runCycle();
    }, POLL_INTERVAL_MS);
  }, pollMs);
}

main().catch(err => {
  console.error('[internship-tracker] Fatal error:', err);
  process.exit(1);
});
