// One-time backfill: run the daily re-evaluation with the caps lifted until
// every active row is classified. Requires DATABASE_URL and ANTHROPIC_API_KEY
// in the shell. Idempotent; safe to rerun.
//
// Usage: DATABASE_URL=... ANTHROPIC_API_KEY=... npx tsx scripts/backfill-classify.ts
import { reevaluate } from '../src/poller/reevaluate';
import { getUnclassified } from '../src/lib/store';
import { closePool } from '../src/lib/db';
import { runMigrations } from '../src/lib/migrate';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || !process.env.ANTHROPIC_API_KEY) throw new Error('DATABASE_URL and ANTHROPIC_API_KEY are required');
  await runMigrations();
  for (let round = 1; round <= 40; round++) {
    console.log(`\n=== round ${round} ===`);
    const r = await reevaluate({ descriptions: 1500, classify: 500 });
    const left = (await getUnclassified(1)).length;
    if (left === 0 && r.classified === 0) break;
  }
}

main()
  .catch(err => { console.error('[backfill-classify] failed:', err); process.exitCode = 1; })
  .finally(() => closePool());
