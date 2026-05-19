import 'dotenv/config';
import { runCycle } from './agent';
import { archiveStalePostings } from '../lib/store';

async function main(): Promise<void> {
  console.log('[internship-tracker] Poll-only mode: running single cycle');
  archiveStalePostings();
  await runCycle();
  console.log('[internship-tracker] Poll-only: done');
}

main().catch(err => {
  console.error('[internship-tracker] Fatal error:', err);
  process.exit(1);
});
