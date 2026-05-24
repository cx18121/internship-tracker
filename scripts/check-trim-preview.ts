// Preview-only: shows length distribution before/after smartTrim across all
// stored descriptions. No DB writes. Used to sanity-check trim aggressiveness
// before committing the cleanup transaction.

import 'dotenv/config';
import { getPool, closePool } from '../src/lib/db';
import { smartTrimDescription } from '../src/poller/utils/description-trim';

async function main(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; source: string; description: string | null }>(
    `SELECT id, source, description FROM internships WHERE description IS NOT NULL AND description != ''`,
  );

  const buckets = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
  const beforeHist = new Map<number, number>();
  const afterHist = new Map<number, number>();
  let totalBefore = 0;
  let totalAfter = 0;

  for (const r of rows) {
    if (!r.description) continue;
    const before = r.description.length;
    const after = smartTrimDescription(r.description).length;
    totalBefore += before;
    totalAfter += after;

    for (const b of buckets) {
      if (before <= b) { beforeHist.set(b, (beforeHist.get(b) ?? 0) + 1); break; }
    }
    if (before > 4000) beforeHist.set(9999, (beforeHist.get(9999) ?? 0) + 1);
    for (const b of buckets) {
      if (after <= b) { afterHist.set(b, (afterHist.get(b) ?? 0) + 1); break; }
    }
    if (after > 4000) afterHist.set(9999, (afterHist.get(9999) ?? 0) + 1);
  }

  console.log(`\nDescriptions: ${rows.length}`);
  console.log(`Total chars: ${totalBefore} → ${totalAfter} (${Math.round((1 - totalAfter / totalBefore) * 100)}% reduction)\n`);

  console.log('Length distribution:');
  console.log('  bucket   before  after');
  for (const b of buckets) {
    console.log(`  ≤${String(b).padStart(4)}    ${String(beforeHist.get(b) ?? 0).padStart(5)}  ${String(afterHist.get(b) ?? 0).padStart(5)}`);
  }

  const sorted = rows
    .filter(r => r.description)
    .map(r => {
      const after = smartTrimDescription(r.description!);
      return { id: r.id, source: r.source, before: r.description!.length, afterLen: after.length, text: r.description!, after };
    })
    .sort((a, b) => (b.before - b.afterLen) - (a.before - a.afterLen));

  console.log('\nTop 5 biggest reductions (HEAD shows preamble-skip effect):');
  for (const s of sorted.slice(0, 5)) {
    console.log(`\n  [${s.source}] ${s.id}: ${s.before} → ${s.afterLen} (-${s.before - s.afterLen})`);
    console.log(`  HEAD BEFORE: ${s.text.slice(0, 180).replace(/\n/g, ' ')}`);
    console.log(`  HEAD AFTER:  ${s.after.slice(0, 180).replace(/\n/g, ' ')}`);
  }

  // Spot-check known IDs from the conversation: ensure substantive-opener
  // descriptions (EnergyHub, Intel) are NOT preamble-skipped.
  console.log('\nSpot-check (substantive openers should NOT be skipped):');
  const spotIds = ['cbd930d65bb0b46cb8a9a38d5eceefaf']; // Intel
  for (const id of spotIds) {
    const r = rows.find(r => r.id === id);
    if (!r?.description) continue;
    const after = smartTrimDescription(r.description);
    console.log(`  [${r.source}] ${id}: ${r.description.length} → ${after.length}`);
    console.log(`    HEAD BEFORE: ${r.description.slice(0, 140).replace(/\n/g, ' ')}`);
    console.log(`    HEAD AFTER:  ${after.slice(0, 140).replace(/\n/g, ' ')}`);
  }
}

main()
  .catch(err => { console.error('[check-trim-preview] failed:', err); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
