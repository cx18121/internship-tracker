/**
 * Standalone LinkedIn closed-job sweep. Useful for ad-hoc cleanup and for
 * dry-running before flipping the scheduled job on in production.
 *
 *   npx tsx src/poller/scripts/revalidate-linkedin.ts            # live archive
 *   npx tsx src/poller/scripts/revalidate-linkedin.ts --dry-run  # count only
 */
import 'dotenv/config';
import { revalidateLinkedIn } from '../linkedin-revalidate';
import { closeDb } from '../../lib/store';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limitFlag = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitFlag ? parseInt(limitFlag.split('=')[1], 10) : undefined;
  const result = await revalidateLinkedIn({ dryRun, limit });
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
