// Smoke test: run one fast-tier poll cycle against the configured DATABASE_URL
// and report cycle stats. Used to verify the pg migration end-to-end before
// the full prod cutover. Safe to delete after the migration ships.

import 'dotenv/config';
import { runCycle } from '../src/poller/agent';
import { closePool } from '../src/lib/db';

async function main(): Promise<void> {
  console.log('[smoke] Running fast cycle (SimplifyJobs only)...');
  const stats = await runCycle({ tier: 'fast' });
  console.log('[smoke] CYCLE RESULT:', JSON.stringify(stats, null, 2));
}

main()
  .catch((e) => { console.error('FAIL:', e); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
