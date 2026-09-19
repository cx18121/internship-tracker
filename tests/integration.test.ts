// DB-backed and HTTP tests. These write rows, so they only run when
// DATABASE_URL is set explicitly in the shell (not read from .env) and points
// at a local Postgres, unless ALLOW_REMOTE_TEST_DB=1.
//
// Env:
//   DATABASE_URL   — Postgres the store tests write to (test rows are deleted after).
//   TEST_BASE_URL  — origin of a running Next server; default http://localhost:3001.
//
// scripts/test-with-server.ts starts the server and runs this file;
// scripts/seed-test-db.ts seeds the rows the /api assertions rely on.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateAndStore, deleteInternship, upsertCompanyFacts, findCompanyFacts, rekeyRows, getCompanyProfiles } from '../src/lib/store';
import { companyKey } from '../src/lib/company-key';
import { jobKey } from '../src/poller/ats';
import { closePool } from '../src/lib/db';
import type { StoredInternship, Internship } from '../src/lib/types';

const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3001';
const API = `${BASE_URL}/api/internships`;
const isLocal = (url: string) => /^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname);
const skip = !DATABASE_URL ? 'DATABASE_URL not set'
  : !isLocal(DATABASE_URL) && process.env.ALLOW_REMOTE_TEST_DB !== '1' ? 'DATABASE_URL is not local; set ALLOW_REMOTE_TEST_DB=1 to run against it'
  : false;

const fixture = (over: Partial<StoredInternship> & { id: string }): StoredInternship => {
  const now = new Date().toISOString();
  return {
    title: 'Test Intern',
    company: 'TestCo',
    location: 'Remote',
    locations: ['Remote'],
    link: `https://example.com/${over.id}`,
    source: 'test',
    postedAt: now,
    seenAt: now, firstSeenAt: now,
    archived: false,
    failedCheckCount: 0,
    normalizedKey: `testco::${over.id}`,
    season: ['summer-2027'],
    ...over,
    jobKey: jobKey(over.link ?? `https://example.com/${over.id}`),
  };
};

after(async () => { if (DATABASE_URL) await closePool(); });

describe('Dedup', { skip }, () => {
  test('Same internship stored twice → 0 new on second insert', async () => {
    const testId = `test-dedup-${Date.now()}`;
    const internship = fixture({
      id: testId,
      title: 'Test Dedup Intern',
      link: 'https://example.com/test-dedup',
    });
    try {
      const r1 = await deduplicateAndStore([internship]);
      assert.equal(r1.newInternships.length, 1, 'First insert: expected 1 new');

      const r2 = await deduplicateAndStore([internship]);
      assert.equal(r2.newInternships.length, 0, 'Second insert: expected 0 new (duplicate)');
    } finally {
      await deleteInternship(testId);
    }
  });
});

describe('Rediscovery backfill', { skip }, () => {
  test('a rediscovered row gains a posted date it lacked', async () => {
    const first = fixture({ id: 'posted-a', link: 'https://x.wd5.myworkdayjobs.com/x/job/y/Intern_JR1', postedAt: undefined });
    await deduplicateAndStore([first]);
    await deduplicateAndStore([{ ...first, postedAt: '2026-05-06' }]);
    const { getInternship } = await import('../src/lib/store');
    assert.equal((await getInternship('posted-a'))?.postedAt?.slice(0, 10), '2026-05-06');
    await deleteInternship('posted-a');
  });
});

describe('Dedup by job identity', { skip }, () => {
  test('the same ATS job under a differently cased slug or another company spelling is one row', async () => {
    const base = fixture({ id: 'jobkey-a', company: 'Datology', title: 'Research Intern', source: 'Ashby', link: 'https://jobs.ashbyhq.com/datologyai/0ced19c2-21ec-4bcc-92d2-68d448279f3f', normalizedKey: 'datology::research' });
    const feed = fixture({ id: 'jobkey-b', company: 'DatologyAI', title: 'Research Intern', source: 'SimplifyJobs', link: 'https://jobs.ashbyhq.com/DatologyAI/0ced19c2-21ec-4bcc-92d2-68d448279f3f/application?embed=true', normalizedKey: 'datologyai::research' });
    const first = await deduplicateAndStore([base]);
    const second = await deduplicateAndStore([feed]);
    assert.equal(first.newInternships.length, 1);
    assert.equal(second.newInternships.length, 0);
    await deleteInternship(base.id);
  });
});

describe('Company catalog', { skip }, () => {
  test('facts match by normalized name or by ATS slug against the domain stem', async () => {
    await upsertCompanyFacts([
      { domain: 'afterquery.com', name: 'AfterQuery', stage: 'Series B', investors: ['boxgroup'], batch: 'Winter 2025', headcount: 30, source: 'test' },
      { domain: 'bedrockrobotics.com', name: 'Bedrock Robotics, Inc.', stage: 'Series B', investors: ['8vc'], source: 'test' },
    ]);
    assert.equal(companyKey('Bedrock Robotics, Inc.'), 'bedrockrobotics');
    assert.equal((await findCompanyFacts('afterquery inc'))?.stage, 'Series B');
    assert.equal((await findCompanyFacts('Bedrock', 'bedrock-robotics'))?.domain, 'bedrockrobotics.com');
    assert.equal(await findCompanyFacts('Droyd Robotics'), null);
  });
});

describe('Company rekey', { skip }, () => {
  test('profiles under old exact-lowercase keys collapse onto one normalized key, curated winning', async () => {
    const { getPool } = await import('../src/lib/db');
    await getPool().query("INSERT INTO company_profiles (company_key, company, tier, known, model) VALUES ('etched.ai', 'Etched.ai', 'solid', false, 'claude'), ('etched', 'Etched', 'hot', true, 'claude') ON CONFLICT (company_key) DO NOTHING");
    const row = fixture({ id: 'rekey-a', company: 'Etched.ai', link: 'https://jobs.ashbyhq.com/etched/11111111-1111-1111-1111-111111111111' });
    await deduplicateAndStore([row]);
    await rekeyRows();
    const profiles = await getCompanyProfiles(['etched']);
    assert.equal(profiles.size, 1);
    assert.equal((await getPool().query("SELECT count(*)::int n FROM company_profiles WHERE company_key IN ('etched.ai', 'etched')")).rows[0].n, 1);
    const { getInternship } = await import('../src/lib/store');
    assert.equal((await getInternship('rekey-a'))?.companyTier, profiles.get('etched')?.tier);
    await deleteInternship('rekey-a');
    await getPool().query("DELETE FROM company_profiles WHERE company_key = 'etched'");
  });
});

describe('Live API', { skip }, () => {
  test('GET /api/internships → response is an array with required fields', async () => {
    const res = await fetch(API);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as Internship[];
    assert.ok(Array.isArray(body), 'response should be an array');
    if (body.length > 0) {
      const item = body[0];
      for (const field of ['id', 'title', 'company', 'score', 'scoreLabel'] as const) {
        assert.ok(field in item, `Missing required field: ${field}`);
      }
    }
  });

  test('GET /api/internships/stats → total > 0, lastPolledAt is valid ISO string', async () => {
    const res = await fetch(`${API}/stats`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const stats = await res.json() as { total: number; lastPolledAt: string | null };
    assert.ok(stats.total > 0, `Expected total > 0, got ${stats.total}`);
    assert.ok(typeof stats.lastPolledAt === 'string', 'lastPolledAt should be a string');
    assert.ok(!isNaN(Date.parse(stats.lastPolledAt!)), `Invalid ISO date: ${stats.lastPolledAt}`);
  });

  test('GET /api/internships?minScore=70 → all items have score >= 70', async () => {
    const res = await fetch(`${API}?minScore=70`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as Internship[];
    assert.ok(Array.isArray(body));
    for (const item of body) {
      assert.ok((item.score ?? 0) >= 70, `Item "${item.title}" has score ${item.score} < 70`);
    }
  });

  test('GET /api/internships?label=A → all items have scoreLabel=A', async () => {
    const res = await fetch(`${API}?label=A`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as Internship[];
    assert.ok(Array.isArray(body));
    for (const item of body) {
      assert.equal(item.scoreLabel, 'A', `Item "${item.title}" has label ${item.scoreLabel}`);
    }
  });
});

describe('Source health API', { skip }, () => {
  test('GET /api/internships/source-health → sources array with expected fields', async () => {
    const res = await fetch(`${API}/source-health`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as { sources: Record<string, unknown>[] };
    assert.ok(Array.isArray(body.sources), 'body.sources should be an array');
    if (body.sources.length > 0) {
      const entry = body.sources[0];
      for (const field of ['name', 'total', 'last24h', 'last7d']) {
        assert.ok(field in entry, `Source entry missing field: ${field}`);
      }
    }
  });
});

describe('Score breakdown API', { skip }, () => {
  test('GET /api/internships/:id/score-breakdown → returns score, scoreLabel, matchedKeywords', async () => {
    const listRes = await fetch(API);
    assert.ok(listRes.ok, `HTTP ${listRes.status} fetching internships list`);
    const list = await listRes.json() as StoredInternship[];
    assert.ok(list.length > 0, 'Need at least 1 internship for score-breakdown test');

    const id = list[0].id;
    const res = await fetch(`${API}/${id}/score-breakdown`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as { score: number; scoreLabel: string; matchedKeywords: string[] };
    assert.ok('score' in body, 'Response must have score');
    assert.ok('scoreLabel' in body, 'Response must have scoreLabel');
    assert.ok('matchedKeywords' in body, 'Response must have matchedKeywords');
    assert.ok(Array.isArray(body.matchedKeywords), 'matchedKeywords must be an array');
  });
});
