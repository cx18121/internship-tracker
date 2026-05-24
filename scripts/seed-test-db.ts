// Seeds a minimal fixture set so the live-API test section can run in CI
// against a fresh Postgres without depending on production data. The fixtures
// upsert by stable id so re-running is idempotent.
//
// Usage:
//   npx tsx scripts/seed-test-db.ts                 # seeds DATABASE_URL
//   DATABASE_URL=postgresql://... seed-test-db.ts   # seeds an alternate DB
//
// Inserts three rows chosen to exercise every assertion the live tests make:
// at least one row with score ≥ 70, at least one with scoreLabel="A", and a
// non-zero count with a valid ISO seenAt for the stats endpoint.

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { getPool, closePool } from '../src/lib/db';
import { deduplicateAndStore } from '../src/lib/store';
import type { Internship } from '../src/lib/types';

async function main(): Promise<void> {
  // Apply schema first — CI starts with an empty pg, so the migration must run
  // before any inserts. Idempotent (CREATE TABLE IF NOT EXISTS), safe locally.
  const pool = getPool();
  const schemaSql = fs.readFileSync(path.join(process.cwd(), 'migrations', '001_initial.sql'), 'utf-8');
  await pool.query(schemaSql);

  const now = new Date().toISOString();
  const fixtures: Internship[] = [
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
  ];

  const result = await deduplicateAndStore(fixtures);
  console.log(`[seed] wrote ${result.newInternships.length} new rows; total stored: ${result.totalStored}`);
}

main()
  .catch(err => { console.error('[seed-test-db] failed:', err); process.exitCode = 1; })
  .finally(async () => { await closePool(); });
