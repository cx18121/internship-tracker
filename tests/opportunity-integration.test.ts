// Writes only to an explicitly selected local test database. All source and
// Discord HTTP requests in alert tests are mocked with captured source fixtures.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sigma from './fixtures/sigma-openings.json';
import reposts from './fixtures/reposted-openings.json';
import { deduplicateAndStore, deleteInternship, getInternship, getPostingIdentities, consolidateOpportunities } from '../src/lib/store';
import { getPool, closePool } from '../src/lib/db';
import { loadNotifSettings, saveNotifSettings } from '../src/lib/app-state';
import { greenhouseDetails } from '../src/poller/ats/greenhouse';
import { linkedInDetails } from '../src/poller/ats/linkedin';
import { enrichPostingIdentities, prepareStoredIdentityCandidates } from '../src/poller/identity';
import { enrichForStorage } from '../src/poller/utils/enrich';
import { openingFacts } from '../src/lib/opportunity';
import { sendBatchAlert } from '../src/poller/notifier';
import { present } from '../src/lib/present';
import type { RawPosting, StoredInternship } from '../src/lib/types';

const db = process.env.DATABASE_URL;
const local = db && /^(localhost|127\.0\.0\.1)$/.test(new URL(db).hostname);
const skip = local ? false : 'An explicitly selected local DATABASE_URL is required';
after(async () => { if (local) await closePool(); });
const gh = greenhouseDetails('sigmacomputing', sigma.greenhouse);
const li = linkedInDetails(sigma.linkedInHtml, '4476525612');
const nyJob = { ...sigma.greenhouse, id: 8001295003,
  absolute_url: 'https://job-boards.greenhouse.io/sigmacomputing/jobs/8001295003', location: { name: 'New York, NY' } };
const ny = greenhouseDetails('sigmacomputing', nyJob);
let sequence = 0;
function examples(): StoredInternship[] {
  const prefix = `opportunity-${Date.now()}-${sequence++}`;
  const now = new Date().toISOString();
  const raws: RawPosting[] = [
    { company: 'Sigma', title: 'Software Engineering Intern (Summer 2027)', link: li.identity!.sourceUrl, locations: ['New York, NY'], source: 'Linkedin', identity: li.identity },
    { company: 'Sigma Computing', title: 'Software Engineer Intern', link: ny.identity!.sourceUrl, locations: ['NYC'], source: 'SimplifyJobs', identity: ny.identity,
      season: ['summer-2027'], salary: { text: '$50.00 per hour', min: 50, max: 50, unit: 'hourly' } },
    { company: 'Sigma Computing', title: sigma.greenhouse.title, link: gh.identity!.sourceUrl, locations: ['SF'], source: 'Greenhouse', identity: gh.identity },
  ];
  return raws.map((r,n) => ({ ...enrichForStorage(r,now), id: `${prefix}-${n}`, roleType: 'swe', degrees: ['bs'], usEligible: 'yes', isInternship: true }));
}
async function cleanup(rows: StoredInternship[]): Promise<void> { for (const r of rows) await deleteInternship(r.id); }

type DiscordBody = { embeds: Array<{ fields: Array<{ name: string; value: string }>; footer: { text: string } }> };
async function withSources(run: (posts: DiscordBody[], requests: string[]) => Promise<void>, guestHtml = sigma.linkedInHtml, responses: Record<string, string | object> = {}): Promise<void> {
  const fetch = globalThis.fetch;
  const token = process.env.DISCORD_BOT_TOKEN;
  const channel = process.env.DISCORD_CHANNEL_INTERNSHIPS;
  const settings = await loadNotifSettings();
  const posts: DiscordBody[] = [], requests: string[] = [];
  await saveNotifSettings({ ...settings, minScore: 0, tiers: [], seasons: [], excludedSources: [], roleTypes: [], degrees: [], metros: [] });
  process.env.DISCORD_BOT_TOKEN = 'test-only';
  process.env.DISCORD_CHANNEL_INTERNSHIPS = 'test-only';
  globalThis.fetch = async (input, init) => {
    const url = String(input); requests.push(url);
    if (url.startsWith('https://discord.com/api/')) {
      const body = JSON.parse(String(init?.body)) as DiscordBody;
      if (body.embeds.some(e => e.fields.some(f => f.value.length > 1024))) {
        return new Response('Embed field value exceeds 1024 characters', { status: 400 });
      }
      posts.push(body);
      return new Response('{}', { status: 200 });
    }
    if (url in responses) return typeof responses[url] === 'string' ? new Response(responses[url] as string, { status: 200 }) : Response.json(responses[url]);
    if (url.includes('linkedin.com/jobs-guest/')) return new Response(guestHtml, { status: 200 });
    if (url.includes('sigmacomputing/jobs/8001295003')) return Response.json(nyJob);
    if (url.includes('sigmacomputing/jobs/7850795003')) return Response.json(sigma.greenhouse);
    throw new Error(`Unexpected HTTP request ${url}`);
  };
  try { await run(posts, requests); } finally {
    globalThis.fetch = fetch;
    if (token === undefined) delete process.env.DISCORD_BOT_TOKEN; else process.env.DISCORD_BOT_TOKEN = token;
    if (channel === undefined) delete process.env.DISCORD_CHANNEL_INTERNSHIPS; else process.env.DISCORD_CHANNEL_INTERNSHIPS = channel;
    await saveNotifSettings(settings);
  }
}

describe('Opportunity storage and alerts', { skip }, () => {
  test('captured same-source reposts do not announce already alerted openings, including reordered batches and restarts', async () => {
    for (const pair of reposts.sameSource) {
      const old = pair.old as unknown as StoredInternship;
      const incoming = pair.incoming as unknown as StoredInternship;
      const copy = { ...incoming, id: `${incoming.id}-another`, identities: incoming.identities!.map(x => ({ ...x, postingKey: 'linkedin:post:9999999999' })) };
      const rows = [old, incoming, copy];
      for (const batch of [[incoming, copy], [copy, incoming]]) {
        try {
          await withSources(async posts => {
            const first = await deduplicateAndStore([old]);
            const clock = Date.now;
            Date.now = () => Date.parse(pair.priorAlertAt);
            try { await sendBatchAlert(first.newInternships.map(r => present(r, new Date(pair.priorAlertAt)))); }
            finally { Date.now = clock; }
            assert.equal(posts.length, 1);
            await closePool();
            const result = await deduplicateAndStore(batch);
            await sendBatchAlert(result.newInternships.map(r => present(r)));
            assert.equal(result.newInternships.length, 0, old.company);
            assert.equal(posts.length, 1, 'no second Discord request for an already alerted opening');
            assert.equal((await getInternship(old.id))?.identities?.length, 3);
          });
        } finally { await cleanup(rows); }
      }
    }
  });

  test('content-only inference cannot form a transitive bridge during ingestion and daily consolidation', async () => {
    const left = Array.from({ length: 12 }, (_, n) => `left${n}`).join(' ');
    const right = Array.from({ length: 12 }, (_, n) => `right${n}`).join(' ');
    const prefix = `bridge-${Date.now()}-${sequence++}`;
    const make = (id: string, content: string): StoredInternship => ({ ...enrichForStorage({ company: prefix, companyObserved: true,
      title: 'Software Engineer Intern', source: 'Linkedin', locations: ['NYC'], link: `https://feed.example/${prefix}/${id}`,
      description: `Responsibilities:\n${content}` }, new Date().toISOString()), id: `${prefix}-${id}` });
    const a = make('a', left), b = make('b', `${left} ${right}`), c = make('c', right);
    try {
      await deduplicateAndStore([a]);
      assert.equal((await deduplicateAndStore([b, c])).newInternships.length, 2);
      await consolidateOpportunities();
      for (const r of [a, b, c]) assert.equal((await getInternship(r.id))?.archived, false, 'no unsupported pair is folded or archived');
      await cleanup([b, c]);
      assert.equal((await deduplicateAndStore([b])).newInternships.length, 0, 'the isolated A/B pair is positively corroborated');
      assert.equal((await deduplicateAndStore([c])).newInternships.length, 1, 'C cannot use retained B to bypass its unsupported A comparison');
      await consolidateOpportunities();
      assert.equal((await getInternship(a.id))?.archived, false);
      assert.equal((await getInternship(c.id))?.archived, false);
      assert.equal((await getInternship(a.id))?.identities?.length, 2);
    } finally { await cleanup([a, b, c]); }
  });

  test('startup backfills captured historical source evidence before alerting a new cross-source ID', async () => {
    const old = { ...reposts.coinbase.old, identities: [] } as unknown as StoredInternship;
    const embed = { ...reposts.coinbase.embed, identities: [] } as unknown as StoredInternship;
    const incoming = reposts.coinbase.incoming as unknown as StoredInternship;
    const rows = [old, embed, incoming];
    try {
      await withSources(async (posts, requests) => {
        const first = await deduplicateAndStore([old, embed]);
        await sendBatchAlert(first.newInternships.filter(r => r.id === old.id).map(r => present(r)));
        assert.equal(posts.length, 1);
        await getPool().query('UPDATE internships SET identities=\'[]\'::jsonb WHERE id=ANY($1::text[])', [[old.id, embed.id]]);
        const before = (await getPool().query('SELECT id,first_seen_at::text,classified_at::text,archived,archive_reason FROM internships WHERE id=ANY($1::text[]) ORDER BY id', [[old.id, embed.id]])).rows;
        await closePool();
        await prepareStoredIdentityCandidates([incoming]);
        const after = (await getPool().query('SELECT id,first_seen_at::text,classified_at::text,archived,archive_reason FROM internships WHERE id=ANY($1::text[]) ORDER BY id', [[old.id, embed.id]])).rows;
        assert.deepEqual(after, before, 'source backfill cannot reset discovery, classification, or archive state');
        assert.ok(requests.includes('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4473969080'));
        assert.ok(requests.includes(embed.link));
        const result = await deduplicateAndStore([incoming]);
        await sendBatchAlert(result.newInternships.map(r => present(r)));
        assert.equal(result.newInternships.length, 0);
        assert.equal(posts.length, 1, 'historical recognition happens before notification selection');
        assert.equal(await getInternship(incoming.id), null);
        assert.ok((await getInternship(embed.id))?.identities?.some(x => x.postingKey === 'greenhouse:coinbase:post:8175462'));
      }, sigma.linkedInHtml, {
        'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4473969080': reposts.coinbase.linkedInHtml,
        [embed.link]: reposts.coinbase.embedHead,
        'https://boards-api.greenhouse.io/v1/boards/coinbase/jobs/8175462?content=true': reposts.coinbase.greenhouse,
      });
    } finally { await cleanup(rows); }
  });

  test('capped historical lookup does not manufacture employer proof or suppress an uncertain immediate alert', async () => {
    const old = { ...reposts.coinbase.old, identities: [] } as unknown as StoredInternship;
    const incoming = reposts.coinbase.incoming as unknown as StoredInternship;
    try {
      await deduplicateAndStore([old]);
      await getPool().query('UPDATE internships SET identities=\'[]\'::jsonb WHERE id=$1', [old.id]);
      await withSources(async (_posts, requests) => {
        await prepareStoredIdentityCandidates([incoming], 0);
        assert.equal(requests.length, 0);
        assert.equal((await deduplicateAndStore([incoming])).newInternships.length, 1);
        assert.equal((await getInternship(old.id))?.identities?.[0].employer, undefined);
      });
    } finally { await cleanup([old, incoming]); }
  });

  test('LinkedIn first, SimplifyJobs later, then Greenhouse: one opportunity and one alert', async () => {
    const rows = examples();
    // Source discovery and store matching are exercised, not just hand-fed aliases.
    const raws: RawPosting[] = rows.map(r => ({ company: r.company, title: r.title, link: r.link, locations: r.locations,
      source: r.source, ...(r.salaryText ? { salary: { text: r.salaryText, min: r.salaryMin!, max: r.salaryMax!, unit: 'hourly' } } : {}) }));
    try {
      await withSources(async (posts, requests) => {
        const counts: number[] = [];
        for (let n = 0; n < raws.length; n++) {
          await enrichPostingIdentities([raws[n]]);
          const stored = { ...enrichForStorage(raws[n], new Date().toISOString()), id: rows[n].id, roleType: 'swe' as const, degrees: ['bs' as const] };
          const result = await deduplicateAndStore([stored]);
          counts.push(result.newInternships.length);
          await sendBatchAlert(result.newInternships.map(r => present(r)));
        }
        assert.deepEqual(counts, [1,0,0]);
        assert.equal(posts.length, 1);
        const keep = await getInternship(rows[0].id);
        assert.ok(keep);
        assert.equal(keep.link, ny.identity!.sourceUrl);
        assert.equal(keep.salaryMin, 50);
        assert.ok(keep.locations.includes('SF'));
        assert.ok(keep.locations.includes('NYC'));
        assert.ok(keep.locations.includes('New York, NY'));
        assert.equal(keep.identities?.length, 3);
        assert.equal(await getInternship(rows[1].id), null);
        assert.equal(await getInternship(rows[2].id), null);

        await closePool(); // Accepted aliases must survive a fresh store connection.
        const aliases = await getPostingIdentities([li.identity!.postingKey, ny.identity!.postingKey, gh.identity!.postingKey]);
        assert.equal(aliases.size, 3);
        const before = requests.length;
        const rediscovered = { ...raws[0], identity: undefined, locations: ['SF'] };
        await enrichPostingIdentities([rediscovered]);
        assert.equal(requests.length, before, 'reuse successful source evidence without another fetch');
        const result = await deduplicateAndStore([{ ...enrichForStorage(rediscovered, new Date().toISOString()), id: rows[0].id }]);
        assert.equal(result.newInternships.length, 0);
        assert.equal((await getInternship(rows[0].id))?.salaryMin, 50, 'an incomplete later sighting cannot erase salary');
        assert.ok((await getInternship(rows[0].id))?.locations.includes('NYC'));
      });
    } finally { await cleanup(rows); }
  });

  test('edited and shortened source descriptions produce one canonical opening and one alert', async () => {
    const rows = examples();
    const guestHtml = sigma.linkedInHtml.replace('Our Internship Program At Sigma', 'Our Student Engineering Program')
      .replace(/<strong>About Us[\s\S]*?(?=<\/div>)/, '');
    const edited = linkedInDetails(guestHtml, '4476525612');
    assert.ok(edited.description.length < li.description.length);
    rows[0].identities = [edited.identity!];
    try {
      await withSources(async posts => {
        const counts = [];
        for (const r of rows) {
          const result = await deduplicateAndStore([r]);
          counts.push(result.newInternships.length);
          await sendBatchAlert(result.newInternships.map(r => present(r)));
        }
        assert.deepEqual(counts, [1, 0, 0]);
        assert.equal(posts.length, 1);
        assert.equal((await getInternship(rows[0].id))?.identities?.length, 3);
        assert.equal((await getInternship(rows[0].id))?.salaryMin, 50);
      }, guestHtml);
    } finally { await cleanup(rows); }
  });

  test('non-GH sources can infer the agreed singleton without descriptions, and aliases survive rediscovery', async () => {
    const rows = examples();
    const observed = rows.slice(0, 2).map((r, n) => ({ ...enrichForStorage({ company: `Inference Example ${rows[0].id}`, title: 'Software Engineer Intern (Summer 2027)',
      source: n ? 'Indeed' : 'YC WaaS', locations: [n ? 'SF' : 'NYC'], link: `https://${n ? 'indeed' : 'yc'}.example/${r.id}` }, new Date().toISOString()), id: r.id }));
    try {
      await withSources(async posts => {
        const first = await deduplicateAndStore([observed[0]]);
        await sendBatchAlert(first.newInternships.map(r => present(r)));
        assert.equal((await deduplicateAndStore([observed[1]])).newInternships.length, 0);
        await closePool();
        assert.equal((await getInternship(observed[0].id))?.identities?.length, 2);
        assert.equal((await deduplicateAndStore([observed[1]])).newInternships.length, 0);
        assert.equal(posts.length, 1);
        assert.deepEqual((await getInternship(observed[0].id))?.locations, ['NYC', 'SF']);
      });
    } finally { await cleanup(observed); }
  });

  test('cache completeness no longer requires a description hash; partial observations retry detail lookup', async () => {
    const rows = examples();
    try {
      await deduplicateAndStore([rows[0]]);
      await withSources(async (_posts, requests) => {
        const raw = { company: 'Sigma', title: rows[0].title, link: rows[0].link, locations: ['NYC'], source: 'Linkedin' };
        await enrichPostingIdentities([raw]);
        assert.equal(requests.length, 0);
        const partial = { ...li.identity!, facts: undefined };
        await getPool().query('UPDATE internships SET identities=$2 WHERE id=$1', [rows[0].id, JSON.stringify([partial])]);
        await enrichPostingIdentities([{ company: 'Sigma', title: rows[0].title, link: rows[0].link, locations: ['NYC'], source: 'Linkedin' }]);
        assert.equal(requests.filter(r => r.includes('jobs-guest')).length, 1);
      });
    } finally { await cleanup(rows); }
  });

  test('same-batch notifications receive the final merged salary, locations and direct link', async () => {
    const rows = examples();
    try {
      await withSources(async posts => {
        const result = await deduplicateAndStore(rows);
        assert.equal(result.newInternships.length, 1);
        const keep = result.newInternships[0];
        assert.equal(keep.id, rows[0].id);
        assert.equal(keep.salaryText, '$50.00 per hour');
        assert.equal(keep.link, ny.identity!.sourceUrl);
        assert.equal(keep.locations.length, 3);
        await sendBatchAlert(result.newInternships.map(r => present(r)));
        assert.equal(posts.length, 1);
        const fields = posts[0].embeds[0].fields;
        assert.equal(fields.find(f => f.name === 'Salary')?.value, '$50.00 per hour');
        assert.ok(fields.find(f => f.name === 'Location')?.value.includes('SF'));
      });
    } finally { await cleanup(rows); }
  });

  test('daily consolidation uses source evidence, persists aliases, and preserves fields and classification', async () => {
    const rows = examples();
    try {
      // Store the legacy rows independently, before identity evidence exists.
      for (const r of rows) await deduplicateAndStore([{ ...r, identities: undefined }]);
      for (const r of rows) await getPool().query('UPDATE internships SET identities=$2 WHERE id=$1', [r.id, JSON.stringify(r.identities)]);
      await getPool().query("UPDATE internships SET role_type='ml_ai', classified_at='2026-10-07 01:01:01.123456+00' WHERE id=$1", [rows[0].id]);
      const before = (await getPool().query('SELECT first_seen_at::text, classified_at::text FROM internships WHERE id=$1', [rows[0].id])).rows[0];
      assert.equal(await consolidateOpportunities(), 2);
      assert.equal(await consolidateOpportunities(), 0);
      const keep = await getInternship(rows[0].id);
      assert.ok(keep);
      assert.equal(keep.roleType, 'ml_ai');
      assert.equal(keep.salaryMin, 50);
      assert.equal(keep.identities?.length, 3);
      const after = (await getPool().query('SELECT first_seen_at::text, classified_at::text FROM internships WHERE id=$1', [rows[0].id])).rows[0];
      assert.deepEqual(after, before);
      for (const r of rows.slice(1)) {
        assert.equal((await getInternship(r.id))?.archived, true);
        assert.equal((await deduplicateAndStore([r])).newInternships.length, 0);
        assert.equal((await getInternship(r.id))?.archived, true, 'absorbed ids cannot create detached revived copies');
      }
    } finally { await cleanup(rows); }
  });

  test('partial rediscovery persists known constraints and cannot merge a different degree track after reconnecting', async () => {
    const rows = examples().slice(0, 2);
    const observe = (n: number, source: string, description: string) => ({ ...enrichForStorage({ company: `Retained constraints ${rows[0].id}`, title: 'Software Engineer Intern (Summer 2027)',
      source, description, locations: ['NYC'], link: `https://${source}.example/${rows[n].id}` }, new Date().toISOString()), id: rows[n].id });
    const original = observe(0, 'feed-a', 'Responsibilities:\nBuild production software using C++.\nRequirements:\nMust be enrolled in a Bachelor program.\nTeam: Analytics');
    const partial = observe(0, 'feed-a', 'Responsibilities:\nBuild production software.');
    const phd = observe(1, 'feed-b', 'Responsibilities:\nBuild production software.\nRequirements:\nPh.D. required.');
    try {
      await deduplicateAndStore([original]);
      assert.equal((await deduplicateAndStore([partial])).newInternships.length, 0);
      await closePool();
      const facts = (await getInternship(original.id))?.identities?.[0].facts;
      assert.deepEqual(facts?.degrees, ['bs']);
      assert.deepEqual(facts?.teams, ['analytics']);
      assert.deepEqual(facts?.technologies, ['c++']);
      assert.equal((await deduplicateAndStore([phd])).newInternships.length, 1);
      assert.equal(await consolidateOpportunities(), 0);
      assert.equal((await getInternship(original.id))?.archived, false);
      assert.equal((await getInternship(phd.id))?.archived, false);
    } finally { await cleanup(rows); }
  });

  test('matching employer, role and term cannot absorb mandatory degree counterevidence beyond the cap', async () => {
    const rows = examples().slice(0, 2);
    const full = 'Responsibilities:\nBuild analytics features and automated tests.\n' + 'Project background information. '.repeat(250);
    rows[0].identities = [{ ...li.identity!, facts: openingFacts(full + '\nRequirements:\nMust be enrolled in a Bachelor program.') }];
    rows[1].identities = [{ ...ny.identity!, facts: openingFacts(full + '\nRequirements:\nPh.D. required.') }];
    rows[0].description = full.slice(0, 6000);
    rows[1].description = full.slice(0, 6000);
    try {
      assert.equal((await deduplicateAndStore(rows)).newInternships.length, 2);
      assert.equal(await consolidateOpportunities(), 0);
      assert.equal((await getInternship(rows[0].id))?.archived, false);
      assert.equal((await getInternship(rows[1].id))?.archived, false);
      await closePool();
      assert.deepEqual((await getInternship(rows[1].id))?.identities?.[0].facts?.degrees, ['phd']);
    } finally { await cleanup(rows); }
  });

  test('known different requisitions and title specializations survive storage and daily cleanup', async () => {
    const rows = examples();
    const variants = [
      { ...rows[2], id: `${rows[2].id}-req`, identities: [{ ...gh.identity!, postingKey: 'greenhouse:sigmacomputing:post:999', openingKey: undefined, requisitionKey: 'greenhouse:sigmacomputing:req:999' }] },
      { ...rows[2], id: `${rows[2].id}-team`, title: 'Software Engineer Intern (Frontend)', identities: [{ ...gh.identity!, postingKey: 'greenhouse:sigmacomputing:post:998', title: 'Software Engineer Intern (Frontend)', openingKey: undefined, requisitionKey: undefined }] },
      { ...rows[2], id: `${rows[2].id}-future`, title: 'Software Engineering Intern (Summer 2028)', identities: [{ ...gh.identity!, postingKey: 'greenhouse:sigmacomputing:post:997', title: 'Software Engineering Intern (Summer 2028)', terms: ['summer-2028'], openingKey: undefined, requisitionKey: undefined }] },
    ];
    try {
      assert.equal((await deduplicateAndStore([rows[2], ...variants])).newInternships.length, 4);
      assert.equal(await consolidateOpportunities(), 0);
      for (const r of [rows[2], ...variants]) assert.equal((await getInternship(r.id))?.archived, false);
    } finally { await cleanup([...rows, ...variants]); }
  });

  test('rediscovering a LinkedIn canonical cannot absorb a retained different requisition', async () => {
    const rows = examples();
    rows[2].identities = [{ ...gh.identity!, postingKey: 'greenhouse:sigmacomputing:post:999',
      openingKey: 'greenhouse:sigmacomputing:internal:99', requisitionKey: 'greenhouse:sigmacomputing:req:999' }];
    try {
      await deduplicateAndStore(rows.slice(0, 2));
      assert.equal((await deduplicateAndStore([rows[2]])).newInternships.length, 1);
      assert.equal((await deduplicateAndStore([rows[0]])).newInternships.length, 0);
      assert.equal(await consolidateOpportunities(), 0);
      assert.equal((await getInternship(rows[0].id))?.archived, false);
      assert.equal((await getInternship(rows[2].id))?.archived, false);
      assert.equal((await getInternship(rows[0].id))?.identities?.find(i => i.requisitionKey)?.requisitionKey, gh.identity!.requisitionKey);
      assert.equal((await getInternship(rows[2].id))?.identities?.[0].requisitionKey, 'greenhouse:sigmacomputing:req:999');
    } finally { await cleanup(rows); }
  });

  for (const mode of ['consolidation', 'rediscovery']) {
    test(`${mode} keeps the genuinely oldest canonical ID with PostgreSQL microsecond timestamps`, async () => {
      const rows = examples().slice(0, 2);
      const prefix = rows[0].id;
      rows[0].id = `${prefix}-z-first`;
      rows[1].id = `${prefix}-a-later`;
      try {
        for (const r of rows) await deduplicateAndStore([{ ...r, identities: undefined }]);
        for (let n = 0; n < rows.length; n++) await getPool().query(
          'UPDATE internships SET identities=$2, first_seen_at=$3 WHERE id=$1',
          [rows[n].id, JSON.stringify(rows[n].identities), `2026-10-07T01:01:01.123${n ? '900' : '100'}Z`]);
        const before = (await getPool().query('SELECT id, first_seen_at::text FROM internships WHERE id=ANY($1::text[]) ORDER BY id', [rows.map(r => r.id)])).rows;
        if (mode === 'consolidation') assert.equal(await consolidateOpportunities(), 1);
        else assert.equal((await deduplicateAndStore([rows[1]])).newInternships.length, 0);
        assert.equal((await getInternship(rows[0].id))?.archived, false);
        assert.equal((await getInternship(rows[0].id))?.firstSeenAt, '2026-10-07T01:01:01.123100Z');
        assert.equal((await getInternship(rows[1].id))?.archived, true);
        const after = (await getPool().query('SELECT id, first_seen_at::text FROM internships WHERE id=ANY($1::text[]) ORDER BY id', [rows.map(r => r.id)])).rows;
        assert.deepEqual(after, before);
      } finally { await cleanup(rows); }
    });
  }

  test('a multi-office alert stays valid and retains all locations in storage', async () => {
    const rows = examples();
    rows[2].locations = Array.from({ length: 60 }, (_, n) => `United States - California - Office ${n}`);
    rows[2].location = rows[2].locations[0];
    try {
      await withSources(async posts => {
        const result = await deduplicateAndStore(rows);
        assert.equal(result.newInternships[0].locations.length, 62);
        assert.equal(await sendBatchAlert(result.newInternships.map(r => present(r))), 1);
        assert.equal(posts.length, 1);
        const value = posts[0].embeds[0].fields.find(f => f.name === 'Location')!.value;
        assert.ok(value.length <= 1024);
        assert.match(value, /… \(\+\d+ more\)$/);
        assert.equal((await getInternship(rows[0].id))?.locations.length, 62);
      });
    } finally { await cleanup(rows); }
  });

  test('an unidentified feed cannot bridge two known openings in the same batch', async () => {
    const rows = examples();
    rows[2].identities = [{ ...rows[2].identities![0], openingKey: 'greenhouse:sigmacomputing:internal:99', requisitionKey: 'greenhouse:sigmacomputing:req:999' }];
    try {
      assert.equal((await deduplicateAndStore(rows)).newInternships.length, 3);
      assert.equal(await consolidateOpportunities(), 0);
    } finally { await cleanup(rows); }
  });

  test('sticky archived aliases stay archived; not-seen aliases revive without a new alert', async () => {
    const rows = examples();
    try {
      await deduplicateAndStore(rows.slice(0,2));
      // Simulate an old check against the LinkedIn URL after both aliases were accepted.
      await getPool().query("UPDATE internships SET archived=true, archive_reason='link gone', failed_check_count=1, last_checked_at=now(), link=$2 WHERE id=$1", [rows[0].id, rows[0].link]);
      assert.equal((await deduplicateAndStore([rows[1]])).newInternships.length, 0);
      assert.equal((await getInternship(rows[0].id))?.archived, true);
      assert.equal((await getInternship(rows[0].id))?.lastCheckedAt, undefined, 'upgrading the link clears its old check timestamp');
      await getPool().query("UPDATE internships SET archive_reason='not seen', failed_check_count=0 WHERE id=$1", [rows[0].id]);
      assert.equal((await deduplicateAndStore([rows[1]])).newInternships.length, 0);
      assert.equal((await getInternship(rows[0].id))?.archived, false);
    } finally { await cleanup(rows); }
  });

  test('a blocked identity lookup keeps immediate alerts rather than speculatively suppressing them', async () => {
    const rows = examples();
    try {
      await withSources(async posts => {
        globalThis.fetch = async (input, init) => {
          if (String(input).startsWith('https://discord.com/api/')) { posts.push(JSON.parse(String(init?.body))); return new Response('{}'); }
          return new Response('', { status: 429 });
        };
        const raw: RawPosting = { company: 'Sigma', title: rows[0].title, link: rows[0].link, source: 'Linkedin', locations: ['New York, NY'] };
        await enrichPostingIdentities([raw]);
        assert.equal(raw.identity, undefined);
        const first = await deduplicateAndStore([{ ...enrichForStorage(raw, new Date().toISOString()), id: rows[0].id }]);
        await sendBatchAlert(first.newInternships.map(r => present(r)));
        const second = await deduplicateAndStore([rows[1]]);
        await sendBatchAlert(second.newInternships.map(r => present(r)));
        assert.equal(posts.length, 2, 'accepted immediate-alert fallback');
      });
    } finally { await cleanup(rows); }
  });

  test('concurrent processes cannot both insert and announce the same proven opening', async () => {
    const rows = examples();
    const exec = promisify(execFile);
    const code = `import {deduplicateAndStore} from './src/lib/store'; import {closePool} from './src/lib/db';
      (async()=>{try{const r=await deduplicateAndStore([JSON.parse(process.env.DEDUPE_TEST_ROW!)]);console.log(r.newInternships.length);}finally{await closePool();}})();`;
    try {
      const results = await Promise.all(rows.slice(0,2).map(row => exec('./node_modules/.bin/tsx', ['-e', code], {
        cwd: process.cwd(), env: { ...process.env, DEDUPE_TEST_ROW: JSON.stringify(row) }, timeout: 20000,
      })));
      assert.equal(results.reduce((sum,r) => sum + Number(r.stdout.trim()), 0), 1);
      assert.equal((await getPool().query('SELECT count(*)::int n FROM internships WHERE id=ANY($1::text[]) AND archived=false', [rows.map(r => r.id)])).rows[0].n, 1);
    } finally { await cleanup(rows); }
  });
});
