// Seeds a minimal fixture DB so the live-API test section can run in CI
// without depending on production data. Honors DATA_DIR — set it to an
// isolated path before invocation so prod data isn't touched.
//
// Usage:
//   DATA_DIR=./test-data npx tsx scripts/seed-test-db.ts
//
// Inserts three rows chosen to exercise every assertion the live tests
// make: at least one row with score ≥ 70, at least one with scoreLabel="A",
// and the count must be > 0 with a valid ISO seenAt for the stats endpoint.

import * as fs from 'fs';
import * as path from 'path';

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'test-data');
fs.mkdirSync(dataDir, { recursive: true });

// store.ts captures DATA_DIR at module load, so the env must be set BEFORE
// the import resolves. Set it here for the (synchronous) import below.
process.env.DATA_DIR = dataDir;

// Wipe any stale fixture from prior runs — keeps CI runs hermetic.
const dbPath = path.join(dataDir, 'internships.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

// Dynamic import so DATA_DIR is read fresh after the env mutation above.
(async () => {
  const { deduplicateAndStore } = await import('../src/lib/store');

  const now = new Date().toISOString();
  const fixtures = [
    {
      id: 'fixture-elite-a',
      title: 'Software Engineer Intern',
      company: 'Anthropic',
      location: 'San Francisco, CA',
      link: 'https://example.com/fixture/anthropic-swe-intern',
      source: 'Fixture',
      postedAt: now,
      seenAt: now,
      score: 95,
      scoreLabel: 'A',
      matchedKeywords: ['python', 'rag'],
      isNew: true,
      applied: false,
    },
    {
      id: 'fixture-top-b',
      title: 'Data Engineer Intern',
      company: 'Snowflake',
      location: 'New York, NY',
      link: 'https://example.com/fixture/snowflake-de-intern',
      source: 'Fixture',
      postedAt: now,
      seenAt: now,
      score: 75,
      scoreLabel: 'B',
      matchedKeywords: ['python', 'sql'],
      isNew: true,
      applied: false,
    },
    {
      id: 'fixture-low-f',
      title: 'General Business Intern',
      company: 'GenericCo',
      location: 'Columbus, OH',
      link: 'https://example.com/fixture/genericco-intern',
      source: 'Fixture',
      postedAt: now,
      seenAt: now,
      score: 15,
      scoreLabel: 'F',
      matchedKeywords: [],
      isNew: true,
      applied: false,
    },
  ] as const;

  const result = await deduplicateAndStore(fixtures as never);
  console.log(`[seed] wrote ${result.newInternships.length} rows to ${dbPath}`);
  console.log(`[seed] total stored: ${result.totalStored}`);
})();
