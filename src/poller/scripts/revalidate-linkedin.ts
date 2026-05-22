/**
 * Standalone LinkedIn closed-job sweep. Useful for ad-hoc cleanup and for
 * dry-running before flipping the scheduled job on in production.
 *
 *   npx tsx src/poller/scripts/revalidate-linkedin.ts                  # incremental (TTL-filtered)
 *   npx tsx src/poller/scripts/revalidate-linkedin.ts --ignore-ttl     # full sweep
 *   npx tsx src/poller/scripts/revalidate-linkedin.ts --dry-run        # count only
 *   npx tsx src/poller/scripts/revalidate-linkedin.ts --limit=30       # cap rows
 */
import 'dotenv/config';
import { revalidateLinkedIn } from '../linkedin-revalidate';
import { closeDb } from '../../lib/store';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const ignoreTtl = process.argv.includes('--ignore-ttl');
  const limitFlag = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitFlag ? parseInt(limitFlag.split('=')[1], 10) : undefined;
  const result = await revalidateLinkedIn({ dryRun, limit, ignoreTtl });
  console.log('Result:', JSON.stringify(result, null, 2));
}

main()
  .catch(err => {
    console.error('[revalidate-linkedin] Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { closeDb(); } catch {}
  });
