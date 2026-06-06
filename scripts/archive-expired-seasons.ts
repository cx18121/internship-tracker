/**
 * archive-expired-seasons.ts
 *
 * One-time cleanup for rows whose internship cycle has already passed — e.g.
 * "Summer 2024", "Winter 2026" — which entered the corpus when the poller
 * started reading SimplifyJobs' off-season README. Going forward the hard
 * filter (filter.ts `expired_season`) drops these at ingestion, so they won't
 * be re-inserted; this script archives the ones already stored.
 *
 *   npx tsx scripts/archive-expired-seasons.ts            # dry-run (default)
 *   npx tsx scripts/archive-expired-seasons.ts --apply    # archive in DB
 *
 * Targets whatever DATABASE_URL points to — local .env reads the shared
 * Railway Postgres, so --apply archives production. Always dry-run first.
 *
 * Uses the SAME predicate as the ingestion filter (isExpiredSeasonTitle on the
 * title), so post-cleanup the active corpus is exactly what the filter keeps —
 * proven by the fixpoint invariant printed after --apply (0 expired remain).
 * Archives (not deletes): reversible, and the filter prevents re-ingestion so
 * archived rows won't be resurrected by the exact-id rediscovery path.
 */
import 'dotenv/config';
import { loadInternships, archiveInternshipsByIds, closeDb } from '../src/lib/store';
import { isExpiredSeasonTitle, deriveSeasonWithDefault } from '../src/lib/seasons';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const all = await loadInternships();
  const active = all.filter((i) => !i.archived);
  const expired = active.filter((i) => isExpiredSeasonTitle(i.title));

  console.log(`Active rows: ${active.length} | expired-season: ${expired.length}`);

  // Group by season token so the scope is auditable before applying.
  const bySeason = new Map<string, number>();
  for (const i of expired) {
    for (const s of deriveSeasonWithDefault(i.title)) bySeason.set(s, (bySeason.get(s) ?? 0) + 1);
  }
  for (const [s, n] of [...bySeason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }
  for (const i of expired.slice(0, 10)) console.log(`   e.g. ${i.title}  ::${i.company}`);

  if (!apply) {
    console.log('\nDry-run. Re-run with --apply to archive these rows.');
    await closeDb();
    return;
  }

  const archived = await archiveInternshipsByIds(expired.map((i) => i.id));
  console.log(`\nArchived ${archived} rows.`);

  // Invariant: the active corpus now contains zero expired-season rows (fixpoint).
  const remaining = (await loadInternships()).filter((i) => !i.archived && isExpiredSeasonTitle(i.title));
  console.log(`Invariant check — expired-season rows still active: ${remaining.length} (expected 0)`);
  if (remaining.length !== 0) {
    console.error('FAILED: expired rows remain active after archive.');
    process.exitCode = 1;
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  try { await closeDb(); } catch {}
  process.exit(1);
});
