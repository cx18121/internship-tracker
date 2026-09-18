// Applies migrations and seeds fixtures for the integration tests. Requires
// DATABASE_URL in the shell; deliberately does not read .env so it cannot
// target production by accident.
//
// Usage: DATABASE_URL=postgresql://... npx tsx scripts/seed-test-db.ts
//
// Inserts three rows chosen to exercise every assertion the live tests make:
// at least one row with score ≥ 70, at least one with scoreLabel="A", and a
// non-zero count with a valid ISO seenAt for the stats endpoint.

import { closePool } from '../src/lib/db';
import { runMigrations } from '../src/lib/migrate';
import { deduplicateAndStore } from '../src/lib/store';
import type { Internship } from '../src/lib/types';

async function main(): Promise<void> {
  await runMigrations();

  const now = new Date().toISOString();
  const fixtures: Internship[] = [
    {
      id: 'fixture-elite-a',
      title: 'Software Engineer Intern',
      company: 'Anthropic',
      location: 'San Francisco, CA',
      locations: ['San Francisco, CA'],
      metros: [],
      link: 'https://example.com/fixture/anthropic-swe-intern',
      source: 'Fixture',
      postedAt: now,
      seenAt: now, firstSeenAt: now,
      score: 95,
      scoreLabel: 'A',
      matchedKeywords: ['python', 'rag'],
      archived: false,
      failedCheckCount: 0,
      normalizedKey: '',
      season: ['summer-2027'],
    },
    {
      id: 'fixture-top-b',
      title: 'Data Engineer Intern',
      company: 'Snowflake',
      location: 'New York, NY',
      locations: ['New York, NY'],
      metros: [],
      link: 'https://example.com/fixture/snowflake-de-intern',
      source: 'Fixture',
      postedAt: now,
      seenAt: now, firstSeenAt: now,
      score: 75,
      scoreLabel: 'B',
      matchedKeywords: ['python', 'sql'],
      archived: false,
      failedCheckCount: 0,
      normalizedKey: '',
      season: ['summer-2027'],
    },
    {
      id: 'fixture-low-f',
      title: 'General Business Intern',
      company: 'GenericCo',
      location: 'Columbus, OH',
      locations: ['Columbus, OH'],
      metros: [],
      link: 'https://example.com/fixture/genericco-intern',
      source: 'Fixture',
      postedAt: now,
      seenAt: now, firstSeenAt: now,
      score: 15,
      scoreLabel: 'F',
      matchedKeywords: [],
      archived: false,
      failedCheckCount: 0,
      normalizedKey: '',
      season: ['summer-2027'],
    },
  ];

  const result = await deduplicateAndStore(fixtures);
  console.log(`[seed] wrote ${result.newInternships.length} new rows; total stored: ${result.totalStored}`);
}

main()
  .catch(err => { console.error('[seed-test-db] failed:', err); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
