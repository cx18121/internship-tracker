// Explicitly local database only. No source fetches, classification, or alerts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { getPool, closePool } from '../src/lib/db';
import { getPostingIdentities } from '../src/lib/store';

const db = process.env.DATABASE_URL;
const local = db && /^(localhost|127\.0\.0\.1)$/.test(new URL(db).hostname);
const skip = local ? false : 'An explicitly selected local DATABASE_URL is required';
// The large performance fixture must not leak into concurrently running
// ingestion or HTTP tests. Each test worker gets its own schema and pool.
const schema = `identity_cache_${process.pid}`;
const pgOptions = process.env.PGOPTIONS;
let admin: Client | undefined;
before(async () => {
  if (!local) return;
  admin = new Client({ connectionString: db });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.internships (LIKE public.internships INCLUDING ALL);
    CREATE TABLE ${schema}.company_profiles (LIKE public.company_profiles INCLUDING ALL);`);
  process.env.PGOPTIONS = `${pgOptions ?? ''} -c search_path=${schema},public`;
  const { rows } = await getPool().query('SELECT current_schema() AS schema');
  assert.equal(rows[0].schema, schema, 'refuse to seed outside the isolated test schema');
});
after(async () => {
  if (!local) return;
  await closePool();
  if (pgOptions === undefined) delete process.env.PGOPTIONS;
  else process.env.PGOPTIONS = pgOptions;
  try { await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
  finally { await admin?.end(); }
});

describe('Identity cache lookup', { skip }, () => {
  test('retains legacy URL evidence, newest feed precedence, board priority, and conflicting boards', async () => {
    const prefix = `cache-semantics-${Date.now()}`;
    const key = 'linkedin:post:9908000001';
    const url = 'https://www.linkedin.com/jobs/view/9908000001';
    const identity = { postingKey: key, sourceUrl: url, title: 'Software Engineer Intern Summer 2027', terms: ['summer-2027'] };
    const pool = getPool();
    const insert = async (name: string, identities: object[], seen: string, link = url) => {
      await pool.query(`INSERT INTO internships (id,title,company,location,link,source,seen_at,identities)
        VALUES ($1,$2,'Cache test','NYC',$3,'Linkedin',$4,$5)`,
      [`${prefix}-${name}`, identity.title, link, seen, JSON.stringify(identities)]);
    };
    try {
      await insert('old', [{ ...identity, origin: 'feed', title: 'Older feed' }], '2026-10-20T12:00:00Z');
      await insert('new', [{ ...identity, origin: 'feed', title: 'Newest feed' }], '2026-10-21T12:00:00Z');
      assert.equal((await getPostingIdentities([key, key], [url, url])).get(key)?.title, 'Newest feed');
      await insert('a-tied-feed', [{ ...identity, origin: 'feed', title: 'Tied feed' }], '2026-10-21T12:00:00Z');
      assert.equal((await getPostingIdentities([key], [url])).get(key)?.title, 'Tied feed', 'equal timestamps use the row ID as a stable tie-breaker');
      await insert('board', [{ ...identity, origin: 'board' }], '2026-10-19T12:00:00Z');
      assert.equal((await getPostingIdentities([key], [url])).get(key)?.title, identity.title);
      await insert('conflict', [{ ...identity, origin: 'board', terms: ['summer-2028'] }], '2026-10-22T12:00:00Z');
      assert.equal((await getPostingIdentities([key], [url])).has(key), false);

      const legacyUrl = 'https://www.linkedin.com/jobs/view/9908000002';
      await insert('legacy', [], '2026-10-23T12:00:00Z', legacyUrl);
      const legacy = (await getPostingIdentities(['linkedin:post:9908000002'], [legacyUrl])).get('linkedin:post:9908000002');
      assert.equal(legacy?.sourceUrl, legacyUrl, 'the direct-link fallback must still synthesize legacy evidence');
      assert.equal(legacy?.title, identity.title);
      assert.deepEqual(await getPostingIdentities([]), new Map());
    } finally {
      await pool.query('DELETE FROM internships WHERE starts_with(id,$1)', [prefix]);
    }
  });

  test('link-only legacy boards and source-URL-only aliases still participate in resolution', async () => {
    const prefix = `cache-aliases-${Date.now()}`;
    const pool = getPool();
    const insert = async (name: string, link: string, identities: object[]) => {
      await pool.query(`INSERT INTO internships (id,title,company,location,link,source,seen_at,identities)
        VALUES ($1,'Software Engineer Intern Summer 2027','Cache aliases','NYC',$2,'Greenhouse',now(),$3)`,
      [`${prefix}-${name}`, link, JSON.stringify(identities)]);
    };
    try {
      const native = 'https://job-boards.greenhouse.io/cachetest/jobs/9908000010';
      const key = 'greenhouse:cachetest:post:9908000010';
      await insert('legacy', native, []);
      assert.equal((await getPostingIdentities([key])).has(key), false);
      assert.equal((await getPostingIdentities([key], [native])).get(key)?.origin, 'board');
      await insert('conflict', 'https://example.com/other', [{ postingKey: key, sourceUrl: native,
        title: 'Software Engineer Intern Summer 2028', terms: ['summer-2028'], origin: 'board' }]);
      assert.equal((await getPostingIdentities([key], [native])).has(key), false, 'legacy link-only evidence participates in board conflicts');

      const alias = 'https://job-boards.greenhouse.io/cachetest/jobs/9908000011';
      const aliasKey = 'greenhouse:cachetest:post:9908000011';
      await insert('old-parser', 'https://example.com/not-the-source-url', [{ postingKey: `url:${alias}`,
        sourceUrl: alias, title: 'Software Engineer Intern', terms: ['summer-2027'] }]);
      assert.equal((await getPostingIdentities([aliasKey], [alias])).get(aliasKey)?.sourceUrl, alias);

      const custom = 'https://careers.example.com/job?gh_jid=9908000012';
      const anonymous = 'greenhouse:_:post:9908000012';
      const board = { postingKey: 'greenhouse:firsttenant:post:9908000012', sourceUrl: custom,
        title: 'Software Engineer Intern', terms: ['summer-2027'], origin: 'board' };
      await insert('first-tenant', 'https://job-boards.greenhouse.io/firsttenant/jobs/9908000012', [board]);
      assert.equal((await getPostingIdentities([anonymous], [custom])).get(anonymous)?.postingKey, board.postingKey);
      await insert('other-tenant', 'https://job-boards.greenhouse.io/othertenant/jobs/9908000012',
        [{ ...board, postingKey: 'greenhouse:othertenant:post:9908000012' }]);
      assert.equal((await getPostingIdentities([anonymous], [custom])).has(anonymous), false, 'ambiguous source URLs cannot select a tenant');
    } finally {
      await pool.query('DELETE FROM internships WHERE starts_with(id,$1)', [prefix]);
    }
  });

  test('a poll-sized alias batch completes without the old full-table comparison cost', { timeout: 30_000 }, async t => {
    const prefix = `cache-scale-${Date.now()}`;
    const pool = getPool();
    // Match the production corpus size and exercise both alias and URL matches.
    // SQL generation keeps fixture setup independent of ingestion/deduplication.
    try {
      await pool.query(`INSERT INTO internships (id,title,company,location,link,source,seen_at,description,identities)
        SELECT $1 || '-' || n, 'Software Engineer Intern Summer 2027', 'Cache scale test', 'NYC',
          'https://www.linkedin.com/jobs/view/' || (9909000000::bigint+n), 'Linkedin', now(), repeat('description ',100),
          jsonb_build_array(jsonb_build_object('postingKey','linkedin:post:' || (9909000000::bigint+n),
            'sourceUrl','https://www.linkedin.com/jobs/view/' || (9909000000::bigint+n),
            'title','Software Engineer Intern Summer 2027','terms',jsonb_build_array('summer-2027'),'origin','feed'))
        FROM generate_series(1,24000) AS n`, [prefix]);
      await pool.query('ANALYZE internships');
      const keys = Array.from({ length: 2000 }, (_, n) => `linkedin:post:${9909000001+n}`);
      const urls = keys.map(key => `https://www.linkedin.com/jobs/view/${key.split(':').at(-1)}`);
      const started = performance.now();
      const identities = await getPostingIdentities([...keys, ...keys], urls);
      const elapsed = performance.now() - started;
      t.diagnostic(`24000 stored rows, 2000 distinct keys with repeated inputs: ${Math.round(elapsed)}ms`);
      assert.equal(identities.size, keys.length);
      for (const key of keys) assert.equal(identities.get(key)?.postingKey, key);
      // Leave headroom for shared CI runners while staying well below the
      // poller's 60-second query timeout. Production query plans/benchmarks
      // establish the index improvement; this is a coarse timeout guard.
      assert.ok(elapsed < 15000, `alias lookup took ${Math.round(elapsed)}ms (budget 15000ms)`);
    } finally {
      await pool.query('DELETE FROM internships WHERE starts_with(id,$1)', [prefix]);
    }
  });
});
