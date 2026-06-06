import 'dotenv/config';
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { applyHardFilters } from './filter';
import { isExpiredSeasonTitle, parseSeason } from '../lib/seasons';
import { scoreInternship } from '../lib/scorer';
import { deduplicateAndStore, archiveStalePostings, getInternships, patchInternship, _deleteInternshipForTest } from '../lib/store';
import type { Internship } from '../lib/types';
import { extractInternFacets } from '../poller/pollers/ats';
import { parseRows } from '../poller/pollers/github';
import { discoverATSTarget } from '../lib/utils/ats-discovery';
import { extractJobIdFromLink } from '../lib/ats-registry';
import { smartTrimDescription, HANDSHAKE_PROMO_BANNER_SOURCE } from './utils/description-trim';
import { buildInternshipRow } from './utils/build-row';
import { canonicalizeCompany } from '../lib/canonicalize-company';
import { stripUtm, stripEmojiPrefix } from '../lib/utils/normalize';
import { pickListFields, LIST_FIELDS } from '../app/_lib/list-item';
import { passesLocalPredicates, filterAndSortInternships } from '../app/_lib/filter-pipeline';
import { groupInternships } from '../app/_components/InternshipList';
import { parseSalary } from '../lib/salary';
import { enrichForStorage } from './utils/enrich';
import { deriveCompany, deriveRoleAndComp, deriveLocation } from './pollers/handshake-parse';
import { stripHtml } from './utils/html';

let passed = 0;
let total = 0;

function test(name: string, fn: () => void): void {
  total++;
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  total++;
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

// ==============================================================
// 1. Filter tests
// ==============================================================

console.log('\n── Filter tests ──────────────────────────────────────────');

test('Non-US location (London, UK) → excluded', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'London, UK' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.reason, 'non_us');
});

test('US location (New York, NY) → passes', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'New York, NY' });
  assert.strictEqual(r.passed, true);
});

test('PhD required in title → excluded', () => {
  const r = applyHardFilters({ title: 'PhD Intern – Research', location: 'New York, NY' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.reason, 'phd_required');
});

test('SWE Intern title → passes', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'New York, NY' });
  assert.strictEqual(r.passed, true);
});

test('Closed posting (🔒) → excluded', () => {
  const r = applyHardFilters({ title: '🔒 Backend Engineer Intern', location: 'Remote' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.reason, 'closed');
});

test('Non-SWE role (Marketing Intern) → excluded', () => {
  const r = applyHardFilters({ title: 'Marketing Intern', location: 'San Francisco, CA' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.reason, 'non_swe');
});

test('SWE role (Backend Engineer Intern) → passes', () => {
  const r = applyHardFilters({ title: 'Backend Engineer Intern', location: 'San Francisco, CA' });
  assert.strictEqual(r.passed, true);
});

// Country-name regression tests — these specific strings leaked through the
// hand-maintained alias list and prompted the swap to world-countries data.
test('Non-US: "Cambridge, United Kingdom" → excluded', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'Cambridge, United Kingdom' });
  assert.strictEqual(r.reason, 'non_us');
});

test('Non-US: "Hsinchu, Taiwan" → excluded', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'Hsinchu, Taiwan' });
  assert.strictEqual(r.reason, 'non_us');
});

test('Non-US: "Moscow, Russia" → excluded (common name, not "Russian Federation")', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'Moscow, Russia' });
  assert.strictEqual(r.reason, 'non_us');
});

test('Non-US: "Abidjan, Ivory Coast" → excluded (common, not "Côte d\'Ivoire")', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'Abidjan, Ivory Coast' });
  assert.strictEqual(r.reason, 'non_us');
});

test('Non-US: "Edinburgh, Scotland" → excluded (UK sub-national)', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'Edinburgh, Scotland' });
  assert.strictEqual(r.reason, 'non_us');
});

test('US: "Las Cruces, New Mexico" → passes (state name beats "mexico" substring)', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'Las Cruces, New Mexico' });
  assert.strictEqual(r.passed, true);
});

// Position-based disambiguation for codes that collide between US states and
// ISO country codes (DE=Delaware/Germany, IN=Indiana/India, CA=California/
// Canada, ID=Idaho/Indonesia). US format puts the code last; foreign format
// puts it first.
test('Non-US: "DE - Berlin" → excluded (country-first with foreign city)', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'DE - Berlin' });
  assert.strictEqual(r.reason, 'non_us');
});

test('Non-US: "CA-ON-MISSISSAUGA-..." → excluded (hierarchical code chain)', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'CA-ON-MISSISSAUGA-P22M01' });
  assert.strictEqual(r.reason, 'non_us');
});

test('Non-US: "IN-Pune" → excluded (foreign city beats Indiana state code)', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'IN-Pune' });
  assert.strictEqual(r.reason, 'non_us');
});

test('US: "AZ - Chandler" → passes (state-prefix form, no foreign city)', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'AZ - Chandler' });
  assert.strictEqual(r.passed, true);
});

test('US: "CA - San Francisco" → passes (California prefix, US city)', () => {
  const r = applyHardFilters({ title: 'SWE Intern', location: 'CA - San Francisco' });
  assert.strictEqual(r.passed, true);
});

// ==============================================================
// 2. Scorer tests
// ==============================================================

console.log('\n── Scorer tests ──────────────────────────────────────────');

// T1(40) + elite(55) + preferred(6) = 101 → clamp 100 → A.
// (description is ignored by scorer — see "Tech keywords in description do NOT
// contribute to score" below — but kept on the input here so the test mirrors
// a realistic row shape.)
test('T1 role + elite company + preferred location → A', () => {
  const r = scoreInternship({
    title: 'Software Engineer Intern',
    company: 'Anthropic',
    location: 'San Francisco, CA',
    description: 'We use Python, RAG, PostgreSQL, vector search.',
  });
  assert.ok(r.score >= 85, `Expected >= 85, got ${r.score}`);
  assert.strictEqual(r.scoreLabel, 'A');
});

// T2(27) + top(35 — Snowflake) + tech(Python+Docker+SQL) + preferred(6) → solid B/A
test('T2 role + top company + tech keywords + preferred city → B or A', () => {
  const r = scoreInternship({
    title: 'Data Engineer Intern',
    company: 'Snowflake',
    location: 'New York',
    description: 'Python, Docker, SQL pipelines.',
  });
  assert.ok(r.score >= 60 && r.score <= 100, `Expected 60–100, got ${r.score}`);
  assert.ok(r.scoreLabel === 'A' || r.scoreLabel === 'B', `Expected A or B, got ${r.scoreLabel}`);
});

// No T1/T2/T3 role keyword + unknown company + no tech → low score, F or D
test('No role/company/tech match → F or D', () => {
  const r = scoreInternship({
    title: 'General Business Intern',
    company: 'Corp LLC',
    location: 'Columbus, OH',
  });
  assert.ok(r.score < 25, `Expected < 25, got ${r.score}`);
  assert.strictEqual(r.scoreLabel, 'F');
});

// "Software Engineer Intern" at any company → at least the T1 role tier (40 pts).
// Score never goes negative — penalty section removed (handled by filter.ts).
test('Bare T1 SWE intern → score = role tier only (40)', () => {
  const r = scoreInternship({
    title: 'Software Engineer Intern',
    company: 'Corp LLC',
    location: '',
  });
  assert.strictEqual(r.score, 40);
});

// All signals firing on an elite SWE role → clamps to ceiling (100)
test('Max raw score → finalScore clamped to 100', () => {
  const r = scoreInternship({
    title: 'Software Engineer Intern',
    company: 'Anthropic',
    location: 'San Francisco, CA',
    description: 'Python, RAG, PostgreSQL, vector search, AI safety, open source, observability.',
  });
  assert.strictEqual(r.score, 100);
});

// Completely empty internship → score 0
test('Zero raw score → finalScore = 0', () => {
  const r = scoreInternship({ title: '', company: '', location: '' });
  assert.strictEqual(r.score, 0);
});

// Morphology: keyword "engineer intern" must match titles using "engineering
// intern" — same role, different inflection. Real-world regression: Apple's
// "Undergrad Engineering Intern" was scoring only the company tier
// because the substring "engineer intern" doesn't appear in "engineerING
// intern". The proper fix tokenizes + stems trailing -ing/-s so morphological
// variants of the same word match.
test('Morphology: "Engineering Intern" matches T3 "engineer intern"', () => {
  const r = scoreInternship({
    title: 'Undergrad Engineering Intern',
    company: 'Apple',
    location: 'United States',
  });
  // T3 (13) + elite Apple (70) = 83
  assert.strictEqual(r.breakdown.role, 13, `expected role=13, got ${r.breakdown.role}`);
  assert.strictEqual(r.score, 83, `expected 83, got ${r.score}`);
});

// Same morphology rule applied to T1: "Software Engineering Intern" should
// pick up the T1 "software engineer" tier (40), not just fall through to T3.
test('Morphology: "Software Engineering Intern" matches T1 "software engineer"', () => {
  const r = scoreInternship({
    title: 'Software Engineering Intern',
    company: 'Corp LLC',
    location: '',
  });
  assert.strictEqual(r.breakdown.role, 40, `expected T1=40, got ${r.breakdown.role}`);
});

// Tech and domain signals were removed: description coverage is ~38% across
// our corpus, so 89% of rows scored 0 from those components anyway. Now they
// shouldn't influence score at all — only role/company/location count.
test('Tech keywords in description do NOT contribute to score', () => {
  const r = scoreInternship({
    title: 'Backend Intern',
    company: 'Corp LLC',
    location: '',
    description: 'Python, TypeScript, React, PostgreSQL, Docker, AWS, Kubernetes.',
  });
  // Only T3 "engineer intern"... wait, "Backend Intern" — "backend" is T1.
  // T1 = 40, no company, no location. Tech keywords in description must add 0.
  assert.strictEqual(r.score, 40, `expected 40 (T1 only), got ${r.score}`);
});

test('Elite company now worth 70 points', () => {
  const r = scoreInternship({
    title: 'Marketing Intern',  // no role match
    company: 'Apple',
    location: '',
  });
  assert.strictEqual(r.breakdown.company, 70, `expected elite=70, got ${r.breakdown.company}`);
});

test('Top company now worth 45 points', () => {
  const r = scoreInternship({
    title: 'Marketing Intern',  // no role match
    company: 'Coinbase',
    location: '',
  });
  assert.strictEqual(r.breakdown.company, 45, `expected top=45, got ${r.breakdown.company}`);
});

// 3rd tier ("solid") added to close the cliff between top (45) and 0.
// Without it, a T1 SWE at a known-but-not-top fintech scored 40 (D) because
// removing tech/domain stripped away its only padding. Solid=20 means
// T1 + solid = 60, landing it in B where it belongs.
test('Solid (3rd-tier) company worth 20 points', () => {
  const r = scoreInternship({
    title: 'Marketing Intern',  // no role match
    company: 'Snyk',
    location: '',
  });
  assert.strictEqual(r.breakdown.company, 20, `expected solid=20, got ${r.breakdown.company}`);
});

test('T1 SWE at solid company lands in B (cliff fix)', () => {
  const r = scoreInternship({
    title: 'Software Engineer Intern',
    company: 'Snyk',
    location: '',
  });
  // T1 (40) + solid (20) = 60 → B
  assert.strictEqual(r.score, 60, `expected 60, got ${r.score}`);
  assert.strictEqual(r.scoreLabel, 'B', `expected B, got ${r.scoreLabel}`);
});

// Single-token tier entries ("apple", "box", "meta") must anchor to the
// START of the company name. Otherwise "Black Box Corp" false-matches "box",
// "Pineapple Express" false-matches "apple", "Mercury Insurance" false-matches
// any "mercury" tier entry. Multi-token entries ("two sigma", "epic games")
// keep substring-phrase semantics.
test('Single-token tier entry anchors to start of company name', () => {
  // "box" is in solid (Box, the file storage company).
  const realBox = scoreInternship({ title: '', company: 'Box', location: '' });
  const realBoxInc = scoreInternship({ title: '', company: 'Box Inc', location: '' });
  const blackBox = scoreInternship({ title: '', company: 'Black Box Corp', location: '' });

  assert.strictEqual(realBox.breakdown.company, 20, `"Box" should match solid, got ${realBox.breakdown.company}`);
  assert.strictEqual(realBoxInc.breakdown.company, 20, `"Box Inc" should match solid, got ${realBoxInc.breakdown.company}`);
  assert.strictEqual(blackBox.breakdown.company, 0, `"Black Box Corp" must NOT match, got ${blackBox.breakdown.company}`);
});

test('Multi-token tier entry still matches anywhere in company name', () => {
  // "two sigma" is in elite. Company "Two Sigma Investments LLC" should match.
  const r = scoreInternship({ title: '', company: 'Two Sigma Investments LLC', location: '' });
  assert.strictEqual(r.breakdown.company, 70, `"Two Sigma Investments" should match elite, got ${r.breakdown.company}`);
});

// Tier resolution order: elite > top > solid. If a company hypothetically
// appeared in both lists, elite wins by virtue of being iterated first.
test('Elite still wins over solid when company is in both lists', () => {
  // Apple is in elite. Even if we added it to solid too, elite should win.
  const r = scoreInternship({
    title: 'Marketing Intern',
    company: 'Apple',
    location: '',
  });
  assert.strictEqual(r.breakdown.company, 70, `elite should win, got ${r.breakdown.company}`);
});

// Verify the config-injection seam: a synthetic config with a single role
// keyword and no other tiers should drive scoring entirely off the injected
// values, with no filesystem read.
test('scoreInternship accepts an injected config — exercises seam without touching disk', () => {
  const synthetic = {
    scoringCeiling: 100,
    companyTiers: {},
    roleTiers: { T1: { points: 42, keywords: ['unicorn engineer'] } },
    locationBonus: {},
  };
  const r = scoreInternship({ title: 'Unicorn Engineer Intern', company: '', location: '' }, synthetic);
  assert.strictEqual(r.score, 42, `injected role tier should drive the whole score, got ${r.score}`);
  assert.deepStrictEqual(r.matchedKeywords, ['unicorn engineer']);
  assert.strictEqual(r.breakdown.role, 42);
  assert.strictEqual(r.breakdown.company, 0);
});

// ==============================================================
// 3. Dedup test
// ==============================================================

async function runDedupTests(): Promise<void> {
  console.log('\n── Dedup tests ───────────────────────────────────────────');
  await testAsync('Same internship stored twice → isNew=false on second insert', async () => {
  const testId = `test-dedup-${Date.now()}`;
  const internship: Internship = {
    id: testId,
    title: 'Test Dedup Intern',
    company: 'TestCo',
    location: 'Remote',
    link: 'https://example.com/test-dedup',
    source: 'test',
    postedAt: new Date().toISOString(),
    seenAt: new Date().toISOString(),
    score: 50,
    scoreLabel: 'C',
    matchedKeywords: [],
    isNew: false,
    applied: false,
  };

  const r1 = await deduplicateAndStore([internship]);
  assert.strictEqual(r1.newInternships.length, 1, 'First insert: expected 1 new');
  assert.strictEqual(r1.newInternships[0].isNew, true, 'First insert: isNew should be true');

  const r2 = await deduplicateAndStore([internship]);
  assert.strictEqual(r2.newInternships.length, 0, 'Second insert: expected 0 new (duplicate)');

  // Cleanup test entry so it doesn't pollute real data
  await _deleteInternshipForTest(testId);
  });
}

// ==============================================================
// 4. Live API tests
// ==============================================================

console.log('\n── Live API tests ────────────────────────────────────────');

async function runApiTests(): Promise<void> {
  const base = 'http://localhost:3001/api/internships';

  await testAsync('GET /api/internships → response is an array with required fields', async () => {
    const res = await fetch(base);
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

  await testAsync('GET /api/internships/stats → total > 0, lastPolledAt is valid ISO string', async () => {
    const res = await fetch(`${base}/stats`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const stats = await res.json() as { total: number; lastPolledAt: string | null };
    assert.ok(stats.total > 0, `Expected total > 0, got ${stats.total}`);
    assert.ok(typeof stats.lastPolledAt === 'string', 'lastPolledAt should be a string');
    assert.ok(!isNaN(Date.parse(stats.lastPolledAt!)), `Invalid ISO date: ${stats.lastPolledAt}`);
  });

  await testAsync('GET /api/internships?minScore=70 → all items have score >= 70', async () => {
    const res = await fetch(`${base}?minScore=70`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as Internship[];
    assert.ok(Array.isArray(body));
    for (const item of body) {
      assert.ok((item.score ?? 0) >= 70, `Item "${item.title}" has score ${item.score} < 70`);
    }
  });

  await testAsync('GET /api/internships?label=A → all items have scoreLabel=A', async () => {
    const res = await fetch(`${base}?label=A`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as Internship[];
    assert.ok(Array.isArray(body));
    for (const item of body) {
      assert.strictEqual(item.scoreLabel, 'A', `Item "${item.title}" has label ${item.scoreLabel}`);
    }
  });
}

// ==============================================================
// 5. Scoring config integrity
// ==============================================================

console.log('\n── Scoring config integrity ──────────────────────────────');

test('scoring-config.json has all required fields', () => {
  const configPath = path.join(process.cwd(), 'data', 'scoring-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  for (const field of ['scoringCeiling', 'companyTiers', 'roleTiers', 'locationBonus']) {
    assert.ok(field in config, `Missing top-level field: ${field}`);
  }

  assert.strictEqual(config.scoringCeiling, 100, `scoringCeiling should be 100, got ${config.scoringCeiling}`);

  assert.ok('elite' in config.companyTiers, 'companyTiers must have elite tier');
  assert.ok('top' in config.companyTiers, 'companyTiers must have top tier');
  assert.ok(Array.isArray(config.companyTiers.elite.companies), 'elite.companies must be an array');
  assert.ok(Array.isArray(config.companyTiers.top.companies), 'top.companies must be an array');
  assert.ok(config.companyTiers.elite.points > config.companyTiers.top.points,
    'elite should be worth more than top');

  for (const tier of ['T1', 'T2', 'T3']) {
    assert.ok(tier in config.roleTiers, `Missing role tier: ${tier}`);
    assert.ok(Array.isArray(config.roleTiers[tier].keywords), `${tier}.keywords must be an array`);
    assert.ok(config.roleTiers[tier].keywords.length > 0, `${tier}.keywords must not be empty`);
  }
  assert.ok(config.roleTiers.T1.points > config.roleTiers.T2.points, 'T1 > T2');
  assert.ok(config.roleTiers.T2.points > config.roleTiers.T3.points, 'T2 > T3');

  assert.ok('preferred' in config.locationBonus, 'locationBonus must have preferred');

  // techStack, techStackCap, domainSignals were removed — description coverage
  // was ~38% across the corpus, so 89% of rows scored 0 from those signals
  // anyway. Their points were folded into the company tiers (elite 55→70,
  // top 35→45). penalties and locationBonus.remote were removed earlier.
  assert.ok(!('techStack' in config), 'techStack section should be removed');
  assert.ok(!('techStackCap' in config), 'techStackCap should be removed');
  assert.ok(!('domainSignals' in config), 'domainSignals section should be removed');
  assert.ok(!('penalties' in config), 'penalties section should be removed');
  assert.ok(!('remote' in config.locationBonus), 'locationBonus.remote should be removed');
});

// ==============================================================
// 5b. Workday facet extraction
// ==============================================================

console.log('\n── Workday facet extraction ──────────────────────────────');

test('extractInternFacets pulls "Intern Group" from jobFamilyGroup', () => {
  const response = {
    facets: [
      { facetParameter: 'jobFamilyGroup', values: [
        { id: 'a', descriptor: 'Development Group', count: 10 },
        { id: 'x', descriptor: 'Intern Group', count: 5 },
        { id: 'b', descriptor: 'Sales Group', count: 7 },
      ]},
    ],
  };
  const r = extractInternFacets(response);
  assert.deepStrictEqual(r, { jobFamilyGroup: ['x'] });
});

test('extractInternFacets pulls multiple matches from workerSubType', () => {
  const response = {
    facets: [
      { facetParameter: 'workerSubType', values: [
        { id: 'reg', descriptor: 'Regular', count: 30 },
        { id: 'int1', descriptor: 'Intern', count: 1 },
        { id: 'int2', descriptor: 'Intern (Fixed Term)', count: 4 },
      ]},
    ],
  };
  const r = extractInternFacets(response);
  assert.deepStrictEqual(r, { workerSubType: ['int1', 'int2'] });
});

test('extractInternFacets matches "Co-op" and "Internship" variants', () => {
  const response = {
    facets: [
      { facetParameter: 'jobFamilyGroup', values: [
        { id: '1', descriptor: 'Co-op Program', count: 3 },
        { id: '2', descriptor: 'Internships', count: 8 },
        { id: '3', descriptor: 'Engineering', count: 50 },
      ]},
    ],
  };
  const r = extractInternFacets(response);
  assert.deepStrictEqual(r, { jobFamilyGroup: ['1', '2'] });
});

test('extractInternFacets ignores facet parameters outside the allowlist', () => {
  const response = {
    facets: [
      { facetParameter: 'locationMainGroup', values: [
        { id: 'loc', descriptor: 'Intern locations', count: 1 },
      ]},
    ],
  };
  const r = extractInternFacets(response);
  assert.deepStrictEqual(r, {});
});

test('extractInternFacets returns {} when no intern facet exists', () => {
  const response = {
    facets: [
      { facetParameter: 'jobFamilyGroup', values: [
        { id: 'a', descriptor: 'Engineering', count: 5 },
        { id: 'b', descriptor: 'Sales', count: 3 },
      ]},
    ],
  };
  const r = extractInternFacets(response);
  assert.deepStrictEqual(r, {});
});

test('extractInternFacets handles missing/empty response gracefully', () => {
  assert.deepStrictEqual(extractInternFacets({}), {});
  assert.deepStrictEqual(extractInternFacets({ facets: [] }), {});
  assert.deepStrictEqual(extractInternFacets({ facets: [{ facetParameter: 'jobFamilyGroup' }] }), {});
});

// ==============================================================
// 6. ATS targets config integrity
// ==============================================================

console.log('\n── ATS targets config integrity ──────────────────────────');

test('ats-targets.json: NVIDIA has board and wdInstance configured', () => {
  const configPath = path.join(process.cwd(), 'data', 'ats-targets.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const targets: any[] = config.targets || [];
  const nvidia = targets.find((t: any) => t.slug === 'nvidia' && t.ats === 'workday');
  assert.ok(nvidia, 'NVIDIA target must exist in ats-targets.json');
  assert.ok(nvidia.board, `NVIDIA must have board field, got: ${JSON.stringify(nvidia)}`);
  assert.ok(nvidia.wdInstance, `NVIDIA must have wdInstance field`);
  assert.strictEqual(nvidia.board, 'NVIDIAExternalCareerSite', `Expected NVIDIAExternalCareerSite, got ${nvidia.board}`);
});

test('ats-targets.json: Intel and Boeing have required Workday fields', () => {
  const configPath = path.join(process.cwd(), 'data', 'ats-targets.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const targets: any[] = config.targets || [];

  const intel = targets.find((t: any) => t.slug === 'intel' && t.ats === 'workday');
  assert.ok(intel?.board, 'Intel must have board field');

  const boeing = targets.find((t: any) => t.slug === 'boeing' && t.ats === 'workday');
  assert.ok(boeing?.board, 'Boeing must have board field');
});

test('ats-discovery: Workday URL extracts slug, board, and wdInstance', () => {
  const target = discoverATSTarget(
    'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/12345',
    'NVIDIA'
  );
  assert.ok(target, 'Should return a target for Workday URL');
  assert.strictEqual(target!.slug, 'nvidia');
  assert.strictEqual(target!.ats, 'workday');
  assert.strictEqual(target!.board, 'NVIDIAExternalCareerSite', `Expected board=NVIDIAExternalCareerSite, got ${target!.board}`);
  assert.strictEqual(target!.wdInstance, 'wd5', `Expected wdInstance=wd5, got ${target!.wdInstance}`);
});

test('ats-discovery: Workday URL with locale prefix extracts correct board', () => {
  const target = discoverATSTarget(
    'https://intel.wd1.myworkdayjobs.com/en-US/External/job/123',
    'Intel'
  );
  assert.ok(target, 'Should return a target');
  assert.strictEqual(target!.slug, 'intel');
  assert.strictEqual(target!.board, 'External', `Expected board=External, got ${target!.board}`);
  assert.strictEqual(target!.wdInstance, 'wd1');
});

test('ats-discovery: Greenhouse URL extracts slug correctly', () => {
  const target = discoverATSTarget('https://boards.greenhouse.io/anthropic/jobs/123', 'Anthropic');
  assert.ok(target, 'Should return target for Greenhouse URL');
  assert.strictEqual(target!.slug, 'anthropic');
  assert.strictEqual(target!.ats, 'greenhouse');
});

test('ats-discovery: Rippling URL extracts slug + ats', () => {
  const target = discoverATSTarget(
    'https://ats.rippling.com/rippling/jobs/35b3ba25-ff2e-4b68-a2d7-61be26f2b24a',
    'Rippling'
  );
  assert.ok(target, 'Should return a target for Rippling URL');
  assert.strictEqual(target!.slug, 'rippling');
  assert.strictEqual(target!.ats, 'rippling');
});

test('ats-discovery: Rippling URL with locale prefix skips locale segment', () => {
  // ats.rippling.com/en-US/{slug}/jobs/{uuid} — the locale must not be read as the slug
  const target = discoverATSTarget(
    'https://ats.rippling.com/en-US/inspectoriocareers/jobs/89ffbf49-5811-4258-a170-4223720eda86',
    'Inspectorio'
  );
  assert.ok(target, 'Should return a target');
  assert.strictEqual(target!.slug, 'inspectoriocareers', `Expected slug=inspectoriocareers, got ${target!.slug}`);
  assert.strictEqual(target!.ats, 'rippling');
});

test('ats-registry: Rippling job id is the uuid after /jobs/ (incl. /apply suffix)', () => {
  assert.strictEqual(
    extractJobIdFromLink('https://ats.rippling.com/rippling/jobs/35b3ba25-ff2e-4b68-a2d7-61be26f2b24a'),
    '35b3ba25-ff2e-4b68-a2d7-61be26f2b24a'
  );
  // Apply-step URLs carry a trailing /apply — the id is still the uuid.
  assert.strictEqual(
    extractJobIdFromLink('https://ats.rippling.com/etg/jobs/d34b3e22-3172-4db1-9d70-b1441b785f5d/apply?step=application'),
    'd34b3e22-3172-4db1-9d70-b1441b785f5d'
  );
});

test('ats-discovery: Workable URL extracts slug + ats and job shortcode', () => {
  const target = discoverATSTarget(
    'https://apply.workable.com/quadric-dot-i-o-inc/j/52EA39411C/apply',
    'Quadric'
  );
  assert.ok(target, 'Should return a target for Workable URL');
  assert.strictEqual(target!.slug, 'quadric-dot-i-o-inc');
  assert.strictEqual(target!.ats, 'workable');
  assert.strictEqual(
    extractJobIdFromLink('https://apply.workable.com/quadric-dot-i-o-inc/j/52EA39411C/apply'),
    '52EA39411C'
  );
});

test('ats-discovery: deny-list shape is valid + includes the 4 audited dead slugs', () => {
  const denylistPath = path.join(process.cwd(), 'data', 'ats-discovery-denylist.json');
  assert.ok(fs.existsSync(denylistPath), 'data/ats-discovery-denylist.json must exist');
  const raw = JSON.parse(fs.readFileSync(denylistPath, 'utf-8'));
  assert.ok(Array.isArray(raw.denied), 'denylist.denied must be an array');
  for (const entry of raw.denied) {
    assert.ok(entry.slug && typeof entry.slug === 'string', `each entry needs a string slug, got ${JSON.stringify(entry)}`);
  }
  const slugs = new Set(raw.denied.map((e: { slug: string }) => e.slug));
  // These 4 came out of the 2026-05-20 Workday audit (commit 1bc0c09) and
  // kept getting re-added by SimplifyJobs link discovery — they're the
  // canonical regression test for the deny-list seam.
  for (const dead of ['kar', 'netflix', 'evrazna', 'cambiahealth']) {
    assert.ok(slugs.has(dead), `deny-list should include audited dead slug '${dead}'`);
  }
});

test('ats-discovery: non-ATS URL returns null', () => {
  const target = discoverATSTarget('https://linkedin.com/jobs/view/123', 'Some Company');
  assert.strictEqual(target, null, 'Non-ATS URL should return null');
});

// ==============================================================
// 6.5. smartTrimDescription tests
// ==============================================================

console.log('\n── smartTrim tests ───────────────────────────────────────');

test('smartTrim: empty input returns empty string', () => {
  assert.strictEqual(smartTrimDescription(''), '');
  assert.strictEqual(smartTrimDescription(null), '');
  assert.strictEqual(smartTrimDescription(undefined), '');
});

test('smartTrim: substantive opener passes through (no marketing-opener match)', () => {
  // Intel-style descriptions open with "Job Details: Job Description: ..."
  // — that's a section header, not a marketing opener. Should not be skipped.
  const input = 'Job Details: Job Description: The Software simulation team is driving software-first strategy at Intel. We need engineers familiar with Python, C++, and Linux. The role involves debugging, automation, and data analysis.';
  const out = smartTrimDescription(input);
  assert.ok(out.startsWith('Job Details:'), `Expected to start with "Job Details:", got: ${out.slice(0, 60)}`);
});

test('smartTrim: marketing-opener + section heading → slices from heading', () => {
  const preamble = 'Who We Are Applied Materials is a global leader in materials engineering solutions used to produce virtually every new chip and advanced display in the world. We design, build and service cutting-edge equipment. We are committed to innovation and excellence at every level. ';
  const role = 'TEAM OVERVIEW: AGS Supplier Engineering Group works with suppliers to validate manufacturing capability. The intern will assist with engineering drawing requirements and NPI team coordination.';
  const out = smartTrimDescription(preamble + role);
  assert.ok(out.startsWith('TEAM OVERVIEW:'), `Expected to start with "TEAM OVERVIEW:", got: ${out.slice(0, 60)}`);
  assert.ok(!out.includes('Applied Materials is a global leader'), 'Marketing preamble should be stripped');
});

test('smartTrim: marketing-opener + no section heading → kept as-is', () => {
  // Marketing-opener detected but no role-section heading later → skip is a no-op.
  const input = 'Who We Are Acme Corp is a global leader in widgets. We are passionate about widgets. Our widgets are the best widgets in the widget industry. We hire interns to help us widget.';
  const out = smartTrimDescription(input);
  assert.ok(out.startsWith('Who We Are Acme'), 'Should fall back to original when no section heading found');
});

test('smartTrim: marketing-opener with section heading at position 0 → no skip', () => {
  // findRoleSectionStart requires position >= MIN_SECTION_POS (200) so
  // a heading at the very start doesn't trigger a meaningless slice.
  const input = 'About the Role: We are hiring an SWE intern. ' + 'The team builds infrastructure. '.repeat(10);
  const out = smartTrimDescription(input);
  assert.ok(out.startsWith('About the Role:'), 'Should preserve a section heading already at the start');
});

test('smartTrim: end-marker trim drops EEO tail', () => {
  const role = 'About the Role: We are seeking a software engineer intern. ' + 'You will write code, review code, and deploy code. '.repeat(8);
  const tail = ' Equal Opportunity Employer: All qualified applicants will receive consideration without regard to race, color, religion, sex, national origin, sexual orientation, gender identity, age, disability, or any other characteristic protected by law.';
  const out = smartTrimDescription(role + tail);
  assert.ok(!out.includes('Equal Opportunity'), `EEO tail should be trimmed, got tail: ${out.slice(-100)}`);
  assert.ok(out.includes('software engineer intern'), 'Real role content should survive');
});

test('smartTrim: end-marker drops ALL-CAPS WHAT WE OFFER tail (but not title-case)', () => {
  // ALL-CAPS "WHAT WE OFFER" is an unambiguous section divider. Title-case
  // "What We Offer" fires too often mid-content (Applied Materials puts a
  // "What We Offer Location: ..." block BEFORE the role section).
  const role = 'Job Description: Build software. We need Python developers. '.repeat(8);
  const allcaps = ' WHAT WE OFFER: Competitive salary, benefits, and culture.';
  const titlecase = ' What We Offer: ' + 'fun engineering work and deep tech challenges. '.repeat(8);

  const outAllcaps = smartTrimDescription(role + allcaps);
  assert.ok(!outAllcaps.includes('WHAT WE OFFER'), 'ALL-CAPS WHAT WE OFFER should be trimmed');

  const outTitle = smartTrimDescription(role + titlecase);
  assert.ok(outTitle.includes('What We Offer'), 'Title-case "What We Offer" should NOT trigger end-trim');
});

test('smartTrim: case-insensitive section heading matches lowercase', () => {
  // Section-heading list is canonically Title-Case, but the regex uses /i.
  // Lowercase "about the role" after a sentence boundary should still match.
  const preamble = 'Who We Are MyCompany is a leading provider of widgets. We are committed to excellence. '.repeat(8);
  const role = ' about the role: We are looking for an intern who can debug Python code.';
  const out = smartTrimDescription(preamble + role);
  assert.ok(/about the role/i.test(out.slice(0, 50)), `Lowercase heading should match. Got head: ${out.slice(0, 100)}`);
});

test('smartTrim: cap at maxLen prefers sentence boundary', () => {
  const sentences = 'This is sentence one. This is sentence two. This is sentence three. '.repeat(50);
  const out = smartTrimDescription(sentences, 200);
  assert.ok(out.length <= 200, `Should respect cap, got length ${out.length}`);
  // Should end at a sentence boundary, not mid-word
  assert.ok(/[.!?]$/.test(out), `Expected sentence-end punctuation, got tail: "${out.slice(-30)}"`);
});

test('smartTrim: cap hard-cuts when no sentence boundary within window', () => {
  // No periods within the cap window → falls back to hard slice.
  const noBoundary = 'word '.repeat(500);
  const out = smartTrimDescription(noBoundary, 100);
  assert.ok(out.length <= 100, `Should respect cap, got length ${out.length}`);
});

test('smartTrim: idempotent — running twice yields same output', () => {
  const samples = [
    '',
    'Who We Are Acme is a leader in widgets. TEAM OVERVIEW: The team builds widgets. ' + 'You will widget. '.repeat(30),
    'Job Description: Build software. Python required. ' + 'Day-to-day: code review. '.repeat(20),
  ];
  for (const s of samples) {
    const once = smartTrimDescription(s);
    const twice = smartTrimDescription(once);
    assert.strictEqual(twice, once, `smartTrim should be idempotent on: "${s.slice(0, 40)}..."`);
  }
});

test('HANDSHAKE_PROMO_BANNER_SOURCE: RegExp built from source matches exact banner', () => {
  const re = new RegExp(HANDSHAKE_PROMO_BANNER_SOURCE, 'gi');
  const banner = "Describe your goals, preferences, or background, and we'll find the best jobs tailored to you. Everything the website does for on-the-go career support. Plus reminders so you never miss a thing.";
  assert.ok(re.test(banner), 'Banner regex should match the exact stable wording');
});

test('HANDSHAKE_PROMO_BANNER_SOURCE: handles variable whitespace between sentences', () => {
  // Real banner may have one or multiple spaces / newlines between the sentences.
  // Build a fresh RegExp per variant — global flag's lastIndex is stateful.
  const variants = [
    "Describe your goals, preferences, or background, and we'll find the best jobs tailored to you.  Everything the website does for on-the-go career support.\nPlus reminders so you never miss a thing.",
    "Describe your goals, preferences, or background, and we'll find the best jobs tailored to you.\n\nEverything the website does for on-the-go career support.\n\nPlus reminders so you never miss a thing",
  ];
  for (const v of variants) {
    assert.ok(new RegExp(HANDSHAKE_PROMO_BANNER_SOURCE, 'gi').test(v), `Should match variant: ${v.slice(0, 40)}...`);
  }
});

// ==============================================================
// 6.6. buildInternshipRow tests
// ==============================================================

console.log('\n── buildInternshipRow tests ──────────────────────────────');

const ROW_DEFAULTS = {
  title: 'SWE Intern',
  company: 'Acme',
  link: 'https://example.com/job/1',
  source: 'Greenhouse',
  seenAt: '2026-05-22T10:00:00.000Z',
} as const;

test('buildInternshipRow: plain-text description set on row', () => {
  const row = buildInternshipRow({ ...ROW_DEFAULTS, description: 'We hire Python interns.' });
  assert.strictEqual(row.description, 'We hire Python interns.');
});

test('buildInternshipRow: descriptionHtml is stripped before storage', () => {
  const row = buildInternshipRow({
    ...ROW_DEFAULTS,
    descriptionHtml: '<p>We hire <strong>Python</strong> interns.</p>',
  });
  assert.ok(row.description, 'Description should be set');
  assert.ok(!row.description!.includes('<'), `Should not contain HTML tags: ${row.description}`);
  assert.ok(row.description!.includes('Python'), 'Should preserve content text');
});

test('buildInternshipRow: descriptionHtml decodes HTML entities', () => {
  const row = buildInternshipRow({
    ...ROW_DEFAULTS,
    descriptionHtml: 'XPENG&nbsp;is a leading smart tech company &amp; provider.',
  });
  assert.ok(!row.description!.includes('&nbsp;'), `&nbsp; should be decoded: ${row.description}`);
  assert.ok(!row.description!.includes('&amp;'), `&amp; should be decoded: ${row.description}`);
});

test('buildInternshipRow: descriptionHtml wins over description when both set', () => {
  const row = buildInternshipRow({
    ...ROW_DEFAULTS,
    description: 'plain text version',
    descriptionHtml: '<p>html version</p>',
  });
  assert.ok(row.description?.includes('html'), `descriptionHtml should win: ${row.description}`);
  assert.ok(!row.description?.includes('plain'), 'plain text should be ignored when html present');
});

test('buildInternshipRow: empty description collapses to undefined', () => {
  assert.strictEqual(buildInternshipRow({ ...ROW_DEFAULTS, description: '' }).description, undefined);
  assert.strictEqual(buildInternshipRow({ ...ROW_DEFAULTS, description: null }).description, undefined);
  assert.strictEqual(buildInternshipRow({ ...ROW_DEFAULTS }).description, undefined);
});

test('buildInternshipRow: whitespace-only description collapses to undefined', () => {
  assert.strictEqual(buildInternshipRow({ ...ROW_DEFAULTS, description: '   \n\t  ' }).description, undefined);
});

test('buildInternshipRow: empty descriptionHtml collapses to undefined', () => {
  assert.strictEqual(buildInternshipRow({ ...ROW_DEFAULTS, descriptionHtml: '' }).description, undefined);
  assert.strictEqual(buildInternshipRow({ ...ROW_DEFAULTS, descriptionHtml: '<br><br>' }).description, undefined);
});

test('buildInternshipRow: wiring fields unchanged by description refactor', () => {
  // Defensive — the description refactor shouldn't have touched postedAt
  // fallback or applied default. Smoke test those alongside.
  const row = buildInternshipRow({
    ...ROW_DEFAULTS,
    upstreamPostedAt: '2026-04-01T00:00:00.000Z',
    location: 'San Francisco, CA',
  });
  assert.strictEqual(row.postedAt, '2026-04-01T00:00:00.000Z');
  assert.strictEqual(row.location, 'San Francisco, CA');
  assert.strictEqual(row.applied, false);
});

test('buildInternshipRow: postedAt falls back to seenAt when upstream is null', () => {
  const row = buildInternshipRow({ ...ROW_DEFAULTS, upstreamPostedAt: null });
  assert.strictEqual(row.postedAt, ROW_DEFAULTS.seenAt);
});

// ==============================================================
// 6.65. canonicalizeCompany tests
// ==============================================================
// WHY: the cross-source dedup key and by-company grouping both key off this
// output. The same role posted as "NVIDIA" and "NVIDIA AI" by different
// boards must collapse to one company, WITHOUT merging genuinely distinct
// companies that happen to share a token ("Character AI" ≠ "Character").

console.log('\n── canonicalizeCompany tests ─────────────────────────────');

const canonEq = (input: string, expected: string) =>
  assert.strictEqual(canonicalizeCompany(input), expected);

test('canonicalize: strips ", Inc."', () => canonEq('Itron, Inc.', 'Itron'));
test('canonicalize: strips " Inc" bare', () => canonEq('Synopsys Inc', 'Synopsys'));
test('canonicalize: strips ", LLC"', () => canonEq('Persistent Systems, LLC', 'Persistent Systems'));
test('canonicalize: strips " Corporation"', () => canonEq('Fortera Corporation', 'Fortera'));
test('canonicalize: strips " Company"', () => canonEq('Base Power Company', 'Base Power'));
test('canonicalize: strips chained "Company, Inc."', () => canonEq('Al Warren Oil Company, Inc.', 'Al Warren Oil'));
test('canonicalize: strips ", N.A."', () => canonEq('The Bancorp Bank, N.A.', 'The Bancorp Bank'));
test('canonicalize: strips trailing (SRA) tag', () => canonEq('Samsung Research America (SRA)', 'Samsung Research America'));
test('canonicalize: alias NVIDIA AI -> NVIDIA', () => canonEq('NVIDIA AI', 'NVIDIA'));
test('canonicalize: alias Perplexity AI -> Perplexity', () => canonEq('Perplexity AI', 'Perplexity'));
test('canonicalize: alias Adobe Systems -> Adobe', () => canonEq('Adobe Systems', 'Adobe'));
test('canonicalize: alias Amazon.com -> Amazon', () => canonEq('Amazon.com', 'Amazon'));
test('canonicalize: alias CACI International -> CACI', () => canonEq('CACI International', 'CACI'));
test('canonicalize: idempotent on alias output', () => canonEq(canonicalizeCompany('NVIDIA AI'), 'NVIDIA'));
test('canonicalize: idempotent on suffix output', () => canonEq(canonicalizeCompany('TikTok Inc.'), 'TikTok'));
test('canonicalize: Character AI NOT merged to Character', () => canonEq('Character AI', 'Character AI'));
test('canonicalize: Palo Alto Networks keeps Networks', () => canonEq('Palo Alto Networks', 'Palo Alto Networks'));
test('canonicalize: Costco not stripped (Co substring)', () => canonEq('Costco', 'Costco'));
test('canonicalize: Smiths Detection not stripped to Smith', () => canonEq('Smiths Detection', 'Smiths Detection'));
test('canonicalize: empty stays empty', () => canonEq('', ''));
test('canonicalize: whitespace trimmed', () => canonEq('  NVIDIA  ', 'NVIDIA'));

// ==============================================================
// 6.65b. stripUtm tests
// ==============================================================
// WHY: apply links are shown to the user (and clicked through to the
// employer) verbatim from the stored `link`. Tracking params like Simplify's
// `?utm_source=Simplify&ref=Simplify` leak which aggregator the applicant
// came from — strip them. The flip side matters just as much: params that are
// the *job identifier* (Indeed `jk=`, Greenhouse `gh_jid=`) must survive, or
// every posting on that board collapses to the same URL and dedup breaks.

console.log('\n── stripUtm tests ────────────────────────────────────────');

test('stripUtm: Simplify utm_source+ref removed', () =>
  assert.strictEqual(
    stripUtm('https://job-boards.greenhouse.io/planetlabs/jobs/7774031?utm_source=Simplify&ref=Simplify'),
    'https://job-boards.greenhouse.io/planetlabs/jobs/7774031'));
test('stripUtm: gh_src source token removed', () =>
  assert.strictEqual(
    stripUtm('https://cellinktechnologies.com/job-listing?gh_jid=4691297005&gh_src=Simplify'),
    'https://cellinktechnologies.com/job-listing?gh_jid=4691297005'));
// Exact-equality (not .includes) so a tracking param leaking through ALONGSIDE
// the kept job id would still fail the test.
test('stripUtm: gh_jid job id KEPT, surrounding tracking stripped', () =>
  assert.strictEqual(
    stripUtm('https://www.brex.com/careers/8434389002?gh_jid=8434389002&utm_source=Simplify&ref=Simplify'),
    'https://www.brex.com/careers/8434389002?gh_jid=8434389002'));
test('stripUtm: Indeed jk job id KEPT, surrounding tracking stripped', () =>
  assert.strictEqual(
    stripUtm('https://www.indeed.com/viewjob?jk=5672f4d7e4739c43&utm_source=Simplify'),
    'https://www.indeed.com/viewjob?jk=5672f4d7e4739c43'));
test('stripUtm: functional params (mobile/needsRedirect) survive, tracking stripped', () =>
  assert.strictEqual(
    stripUtm('https://careers-cotiviti.icims.com/jobs/18817/job?mobile=true&needsRedirect=false&utm_source=Simplify&ref=Simplify'),
    'https://careers-cotiviti.icims.com/jobs/18817/job?mobile=true&needsRedirect=false'));
test('stripUtm: clean link unchanged', () =>
  assert.strictEqual(
    stripUtm('https://jobs.lever.co/ivo/83b626de-53c8-4505-b0ea-253fdcb83680/apply'),
    'https://jobs.lever.co/ivo/83b626de-53c8-4505-b0ea-253fdcb83680/apply'));
test('stripUtm: empty string passes through', () => assert.strictEqual(stripUtm(''), ''));

// ==============================================================
// 6.7. pickListFields / LIST_FIELDS projection tests
// ==============================================================

console.log('\n── pickListFields tests ──────────────────────────────────');

test('pickListFields keeps UI/consumer fields and drops heavy unused ones', () => {
  const full = {
    id: 'x1', title: 'SWE Intern', company: 'Acme', location: 'NYC',
    link: 'https://a.co/x1', source: 'Greenhouse', postedAt: '2026-01-01',
    seenAt: '2026-01-02', score: 88, scoreLabel: 'A',
    matchedKeywords: ['backend'], applied: false, hidden: false,
    salaryText: '$50/hr', season: ['summer-2026'],
    // fields that must NOT ship to the list view:
    description: 'x'.repeat(5000), salaryMin: 50, salaryMax: 60,
    salaryUnit: 'hourly', isNew: true,
  };
  const out = pickListFields(full as any);
  // Required by ATS consumer (find-ats-links-daily.ts) + the list/card UI.
  for (const f of ['id', 'title', 'company', 'link', 'source', 'score',
                   'scoreLabel', 'postedAt', 'seenAt', 'location',
                   'matchedKeywords', 'applied', 'hidden', 'salaryText', 'season']) {
    assert(f in out, `expected field ${f} to be kept`);
  }
  // Heavy / unused — must be dropped.
  for (const f of ['description', 'salaryMin', 'salaryMax', 'salaryUnit', 'isNew']) {
    assert(!(f in out), `expected field ${f} to be dropped`);
  }
  // The allowlist and the output keys agree.
  assert.deepStrictEqual(Object.keys(out).sort(), [...LIST_FIELDS].sort());
});

test('pickListFields omits allowlisted fields that are undefined on the row', () => {
  const sparse = {
    id: 'x2', title: 'T', company: 'C', location: 'L', link: 'l',
    source: 'S', postedAt: '2026-01-01', seenAt: '2026-01-02',
    score: 50, scoreLabel: 'B', matchedKeywords: [], applied: false,
    // hidden, salaryText, season intentionally absent (undefined)
  };
  const out = pickListFields(sparse as any);
  for (const f of ['hidden', 'salaryText', 'season']) {
    assert(!(f in out), `expected absent field ${f} to be omitted, not set to undefined`);
  }
  assert(out.id === 'x2'); // present fields still projected
});

// ==============================================================
// 7. Archive stale postings test
// ==============================================================

async function runArchiveTests(): Promise<void> {
  console.log('\n── Archive tests ─────────────────────────────────────────');

  // archiveStalePostings() with a default cutoff is destructive against the
  // real DB — it archives EVERY row whose seen_at is older than the cutoff,
  // not just the test row this test inserts. Bit us once already (a normal
  // `npm test` run silently archived ~370 stale rows). Opt-in: set
  // TEST_INCLUDE_DESTRUCTIVE=1 to run it (against a throwaway DB ideally).
  if (process.env.TEST_INCLUDE_DESTRUCTIVE !== '1') {
    console.log('SKIP  archiveStalePostings() test (set TEST_INCLUDE_DESTRUCTIVE=1 to run)');
    return;
  }

  await testAsync('archiveStalePostings() archives old internships, getInternships respects includeArchived', async () => {
    const testId = `test-archive-${Date.now()}`;
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const internship: Internship = {
      id: testId,
      title: 'Stale Archive Test Intern',
      company: 'ArchiveCo',
      location: 'Remote',
      link: 'https://example.com/test-archive',
      source: 'test',
      postedAt: sixtyDaysAgo,
      seenAt: sixtyDaysAgo,
      score: 40,
      scoreLabel: 'C',
      matchedKeywords: [],
      isNew: false,
      applied: false,
    };

    // Insert via deduplicateAndStore
    await deduplicateAndStore([internship]);

    // Archive stale postings (default 30 days)
    const archived = await archiveStalePostings();
    assert.ok(archived >= 1, `Expected at least 1 archived, got ${archived}`);

    // Without includeArchived: should NOT find the test internship
    const withoutArchived = await getInternships();
    const found1 = withoutArchived.find(i => i.id === testId);
    assert.strictEqual(found1, undefined, 'Archived internship should not appear without includeArchived');

    // With includeArchived: SHOULD find the test internship
    const withArchived = await getInternships({ includeArchived: true });
    const found2 = withArchived.find(i => i.id === testId);
    assert.ok(found2, 'Archived internship should appear with includeArchived=true');
    assert.strictEqual(found2!.archived, true, 'archived flag should be true');

    // Cleanup
    await _deleteInternshipForTest(testId);
  });
}

// ==============================================================
// 8. Application tracking test
// ==============================================================

async function runApplicationTrackingTests(): Promise<void> {
  console.log('\n── Application tracking tests ─────────────────────────────');

  await testAsync('patchInternship stores appliedAt, applicationUrl, applicationStatus', async () => {
    const testId = `test-apptrack-${Date.now()}`;
    const internship: Internship = {
      id: testId,
      title: 'App Tracking Test Intern',
      company: 'TrackCo',
      location: 'New York, NY',
      link: 'https://example.com/test-apptrack',
      source: 'test',
      postedAt: new Date().toISOString(),
      seenAt: new Date().toISOString(),
      score: 60,
      scoreLabel: 'C',
      matchedKeywords: [],
      isNew: false,
      applied: false,
    };

    // Insert
    await deduplicateAndStore([internship]);

    // Patch with application fields
    const now = new Date().toISOString();
    const patched = await patchInternship(testId, {
      applied: true,
      appliedAt: now,
      applicationUrl: 'https://apply.example.com/123',
      applicationStatus: 'applied',
    });

    assert.ok(patched, 'patchInternship should return the updated internship');
    assert.strictEqual(patched!.applied, true, 'applied should be true');
    assert.strictEqual(patched!.appliedAt, now, 'appliedAt should match');
    assert.strictEqual(patched!.applicationUrl, 'https://apply.example.com/123', 'applicationUrl should match');
    assert.strictEqual(patched!.applicationStatus, 'applied', 'applicationStatus should match');

    // Cleanup
    await _deleteInternshipForTest(testId);
  });
}

// ==============================================================
// 9. Source health live API test
// ==============================================================

async function runSourceHealthApiTests(): Promise<void> {
  console.log('\n── Source health API tests ────────────────────────────────');

  const base = 'http://localhost:3001/api/internships';

  await testAsync('GET /api/internships/source-health → sources array with expected fields', async () => {
    const res = await fetch(`${base}/source-health`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as { sources: any[] };
    assert.ok(Array.isArray(body.sources), 'body.sources should be an array');
    if (body.sources.length > 0) {
      const entry = body.sources[0];
      for (const field of ['name', 'total', 'last24h', 'last7d']) {
        assert.ok(field in entry, `Source entry missing field: ${field}`);
      }
    }
  });
}

// ==============================================================
// 10. Score breakdown live API test
// ==============================================================

async function runScoreBreakdownApiTests(): Promise<void> {
  console.log('\n── Score breakdown API tests ──────────────────────────────');

  const base = 'http://localhost:3001/api/internships';

  await testAsync('GET /api/internships/:id/score-breakdown → returns score, scoreLabel, matchedKeywords', async () => {
    // First, get an internship to use its ID
    const listRes = await fetch(base);
    assert.ok(listRes.ok, `HTTP ${listRes.status} fetching internships list`);
    const list = await listRes.json() as Internship[];
    assert.ok(list.length > 0, 'Need at least 1 internship for score-breakdown test');

    const id = list[0].id;
    const res = await fetch(`${base}/${id}/score-breakdown`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as { score: number; scoreLabel: string; matchedKeywords: string[] };
    assert.ok('score' in body, 'Response must have score');
    assert.ok('scoreLabel' in body, 'Response must have scoreLabel');
    assert.ok('matchedKeywords' in body, 'Response must have matchedKeywords');
    assert.ok(Array.isArray(body.matchedKeywords), 'matchedKeywords must be an array');
  });
}

// ==============================================================
// filter-pipeline parity tests
// ==============================================================

console.log('\n── filter-pipeline tests ─────────────────────────────────');

test('filterAndSortInternships: minScore + source gate, score-desc order', () => {
  const corpus = [
    { id: 'a', title: 'SWE', company: 'A', location: 'NYC', source: 'Greenhouse', score: 90, applied: false, hidden: false, matchedKeywords: [] },
    { id: 'b', title: 'SWE', company: 'B', location: 'NYC', source: 'Indeed',     score: 40, applied: false, hidden: false, matchedKeywords: [] },
    { id: 'c', title: 'SWE', company: 'C', location: 'NYC', source: 'Greenhouse', score: 70, applied: false, hidden: false, matchedKeywords: [] },
  ] as any[];
  const out = filterAndSortInternships(corpus, {
    searchLower: '', selectedLocations: [], locationText: '',
    tier: 'all', seasons: [], appliedFilter: 'all', showHidden: false,
    selectedSources: ['Greenhouse'], minScore: 50, windowCutoff: null,
    includeKeywords: [], excludeKeywords: [], selectedRoles: [], sortBy: 'score',
  });
  // Indeed row excluded by source; score-40 row excluded by minScore;
  // remaining ordered score-desc.
  assert.deepStrictEqual(out.map(i => i.id), ['a', 'c']);
});

test('filterAndSortInternships: search matches company/title/location, hidden excluded unless showHidden', () => {
  const corpus = [
    { id: 'a', title: 'Backend Intern', company: 'Acme', location: 'NYC', source: 'X', score: 50, applied: false, hidden: false, matchedKeywords: [] },
    { id: 'b', title: 'Frontend Intern', company: 'Beta', location: 'SF', source: 'X', score: 60, applied: false, hidden: true, matchedKeywords: [] },
  ] as any[];
  const base = {
    selectedLocations: [], locationText: '', tier: 'all' as const, seasons: [],
    appliedFilter: 'all' as const, selectedSources: [], minScore: 0, windowCutoff: null,
    includeKeywords: [], excludeKeywords: [], selectedRoles: [], sortBy: 'score' as const,
  };
  // Search "acme" hits company on row a only.
  assert.deepStrictEqual(
    filterAndSortInternships(corpus, { ...base, searchLower: 'acme', showHidden: false }).map(i => i.id),
    ['a'],
  );
  // Hidden row b is excluded by default, included when showHidden.
  assert.deepStrictEqual(
    filterAndSortInternships(corpus, { ...base, searchLower: '', showHidden: false }).map(i => i.id),
    ['a'],
  );
  assert.deepStrictEqual(
    filterAndSortInternships(corpus, { ...base, searchLower: '', showHidden: true }).map(i => i.id).sort(),
    ['a', 'b'],
  );
});

test('filterAndSortInternships: sortBy posted orders by postedAt desc', () => {
  const corpus = [
    { id: 'old', title: 'T', company: 'C', location: 'L', source: 'X', score: 99, postedAt: '2026-01-01', applied: false, hidden: false, matchedKeywords: [] },
    { id: 'new', title: 'T', company: 'C', location: 'L', source: 'X', score: 10, postedAt: '2026-05-01', applied: false, hidden: false, matchedKeywords: [] },
  ] as any[];
  const out = filterAndSortInternships(corpus, {
    searchLower: '', selectedLocations: [], locationText: '', tier: 'all', seasons: [],
    appliedFilter: 'all', showHidden: false, selectedSources: [], minScore: 0,
    windowCutoff: null, includeKeywords: [], excludeKeywords: [], selectedRoles: [], sortBy: 'posted',
  });
  assert.deepStrictEqual(out.map(i => i.id), ['new', 'old']); // newest first, ignores score
});

test('passesLocalPredicates: search and location branches', () => {
  const row = { company: 'Acme', title: 'Backend Intern', location: 'New York, NY' } as any;
  const none = { selectedLocations: [], locationText: '' };
  // No predicates → passes.
  assert(passesLocalPredicates(row, { searchLower: '', ...none }) === true);
  // Search matches title (case-insensitive), fails when absent.
  assert(passesLocalPredicates(row, { searchLower: 'backend', ...none }) === true);
  assert(passesLocalPredicates(row, { searchLower: 'frontend', ...none }) === false);
  // locationText substring: 'york' matches, 'boston' does not.
  assert(passesLocalPredicates(row, { searchLower: '', selectedLocations: [], locationText: 'york' }) === true);
  assert(passesLocalPredicates(row, { searchLower: '', selectedLocations: [], locationText: 'boston' }) === false);
  // selectedLocations: a matching chip passes, a non-matching chip fails.
  assert(passesLocalPredicates(row, { searchLower: '', selectedLocations: ['new york'], locationText: '' }) === true);
  assert(passesLocalPredicates(row, { searchLower: '', selectedLocations: ['remote'], locationText: '' }) === false);
});

console.log('\n── groupInternships tests ────────────────────────────────');

test('groupInternships: score sort orders companies by avg score desc', () => {
  const corpus = [
    { id: 'a1', company: 'Acme', score: 80, applied: false },
    { id: 'a2', company: 'Acme', score: 90, applied: true },
    { id: 'b1', company: 'Beta', score: 95, applied: false },
    { id: 'c1', company: 'Cyon', score: 50, applied: false },
  ] as any[];
  const out = groupInternships(corpus, 'score');
  assert.deepStrictEqual(out.map(g => g.company), ['Beta', 'Acme', 'Cyon']); // avg 95, 85, 50
  const acme = out.find(g => g.company === 'Acme')!;
  assert.strictEqual(acme.avgScore, 85);
  assert.strictEqual(acme.appliedCount, 1);
});

test('groupInternships: posted sort orders companies by newest posting, ignoring score', () => {
  const corpus = [
    { id: 'old', company: 'OldCo', score: 99, postedAt: '2026-01-01', applied: false },
    { id: 'new', company: 'NewCo', score: 1,  postedAt: '2026-05-01', applied: false },
  ] as any[];
  // The bug this guards: under "posted", NewCo ranks first because it posted more
  // recently — NOT OldCo, which would win on score. Company order must follow the
  // active sort, not always avg score.
  assert.deepStrictEqual(groupInternships(corpus, 'posted').map(g => g.company), ['NewCo', 'OldCo']);
});

test('groupInternships: posted sort ranks a company by its most-recent role', () => {
  const corpus = [
    { id: 'x-feb', company: 'X', score: 0, postedAt: '2026-02-01', applied: false },
    { id: 'x-apr', company: 'X', score: 0, postedAt: '2026-04-01', applied: false },
    { id: 'y-mar', company: 'Y', score: 0, postedAt: '2026-03-01', applied: false },
  ] as any[];
  const out = groupInternships(corpus, 'posted');
  // X's newest role (Apr) beats Y's only role (Mar). A min/first-based ranking
  // would see X's first role (Feb) and flip the order — this asserts max-based.
  assert.deepStrictEqual(out.map(g => g.company), ['X', 'Y']);
  // Roles within a group keep their incoming order (the caller pre-sorts the list).
  assert.deepStrictEqual(out.find(g => g.company === 'X')!.items.map((i: any) => i.id), ['x-feb', 'x-apr']);
});

test('groupInternships: blank company → "Unknown"; null postedAt sorts last under posted', () => {
  const corpus = [
    { id: 'k', company: 'Known', score: 0, postedAt: '2026-05-01', applied: false },
    { id: 'u', company: '',      score: 0, postedAt: null,         applied: false },
  ] as any[];
  // Empty company name buckets into "Unknown"; a null postedAt is treated as
  // epoch 0, so it ranks last under the posted sort.
  assert.deepStrictEqual(groupInternships(corpus, 'posted').map(g => g.company), ['Known', 'Unknown']);
});

test('groupInternships: case-only company variants merge into one section', () => {
  // WHY: ingestion canonicalizes legal suffixes ("QUADRIC PTY LTD" → "QUADRIC")
  // but can't normalize intentional casing, so "Quadric" and "QUADRIC" survive
  // as distinct strings. Grouping must still treat them as ONE company, else
  // the same company splits into two sections — the exact bug we're fixing.
  const corpus = [
    { id: 'q1', company: 'Quadric', score: 80, applied: false },
    { id: 'q2', company: 'QUADRIC', score: 90, applied: true },
  ] as any[];
  const out = groupInternships(corpus, 'score');
  assert.strictEqual(out.length, 1, 'casing variants must collapse to one group');
  assert.strictEqual(out[0].items.length, 2);
  assert.strictEqual(out[0].appliedCount, 1);
  // Display picks the non-ALL-CAPS casing when counts tie.
  assert.strictEqual(out[0].company, 'Quadric');
});

// ==============================================================
// Salary parser tests
// ==============================================================

console.log('\n── Salary parser tests ───────────────────────────────────');

test('Unpaid role yields no salary even if description has a $ figure', () => {
  const s = parseSalary('Full Stack Engineering Internship Unpaid. Our platform manages $120,000-$180,000 in assets.');
  assert.strictEqual(s.text, null);
  assert.strictEqual(s.unit, null);
});

test('Bare unit-less $ range is no longer treated as salary', () => {
  const s = parseSalary('Software Engineer Intern. We raised $50,000-$75,000 in our seed round.');
  assert.strictEqual(s.text, null);
});

test('Anchored hourly range still parses', () => {
  const s = parseSalary('SWE Intern $25-30/hr');
  assert.strictEqual(s.unit, 'hourly');
  assert.strictEqual(s.min, 25);
  assert.strictEqual(s.max, 30);
});

test('Anchored k-suffix yearly range still parses', () => {
  const s = parseSalary('New Grad $120-180k');
  assert.strictEqual(s.unit, 'yearly');
  assert.strictEqual(s.min, 120000);
  assert.strictEqual(s.max, 180000);
});

// ==============================================================
// Enrich salary-precedence tests
// ==============================================================

console.log('\n── Enrich salary-precedence tests ────────────────────────');

test('Scraper-provided salary is forwarded, not overwritten by description parse', () => {
  const row = enrichForStorage({
    title: 'SWE Intern', company: 'Acme', link: 'https://x.com/a', source: 'Handshake',
    salaryText: '$25/hr', salaryMin: 25, salaryMax: 25, salaryUnit: 'hourly',
    description: 'We manage $200,000-$300,000/yr portfolios.',
  }, '2026-06-04T00:00:00.000Z');
  assert.strictEqual(row.salaryText, '$25/hr');
  assert.strictEqual(row.salaryUnit, 'hourly');
});

test('Handshake row with no scraper salary does not invent one from description', () => {
  const row = enrichForStorage({
    title: 'AI Specialist', company: 'A Free Bird', link: 'https://x.com/b', source: 'Handshake',
    description: 'Stipend pool of $100,000-$150,000/yr shared across the cohort.',
  }, '2026-06-04T00:00:00.000Z');
  assert.strictEqual(row.salaryText, undefined);
});

test('Non-Handshake row still parses salary from description', () => {
  const row = enrichForStorage({
    title: 'SWE Intern $30/hr', company: 'Acme', link: 'https://x.com/c', source: 'Greenhouse',
  }, '2026-06-04T00:00:00.000Z');
  assert.strictEqual(row.salaryUnit, 'hourly');
});

console.log('\n── Handshake card parser tests ───────────────────────────');

test('deriveCompany prefers logo alt', () => {
  assert.strictEqual(
    deriveCompany('Goalbound', 'Goalbound Software Engineering Internship $25/hr · Internship · Jun 14—Jul 30 Remote 3d ago'),
    'Goalbound'
  );
});

test('deriveCompany returns null when no logo (caller falls back / drops)', () => {
  assert.strictEqual(deriveCompany('', 'CGTech Software Engineer (UX) Intern $32/hr · Internship · Jun 23—Aug 27 Irvine, CA New'), null);
});

test('deriveRoleAndComp strips company prefix and cuts at pay token', () => {
  const r = deriveRoleAndComp('Goalbound', 'Goalbound Software Engineering Internship $25/hr · Internship · Jun 14—Jul 30 Remote 3d ago');
  assert.strictEqual(r.role, 'Software Engineering Internship');
  assert.strictEqual(r.comp, '$25/hr');
});

test('deriveRoleAndComp handles Unpaid token (comp empty)', () => {
  const r = deriveRoleAndComp('A Free Bird Corporation', 'A Free Bird Corporation AI Specialist Unpaid · Internship Remote 2wk ago');
  assert.strictEqual(r.role, 'AI Specialist');
  assert.strictEqual(r.comp, '');
});

test('deriveRoleAndComp falls back to cut at " · " when no pay/Unpaid token', () => {
  const r = deriveRoleAndComp('Acme', 'Acme Data Intern · Internship · Jun 1—Aug 1 Remote 1d ago');
  assert.strictEqual(r.role, 'Data Intern');
  assert.strictEqual(r.comp, '');
});

test('deriveRoleAndComp chops the tail on a no-pay, no-separator card (uses location)', () => {
  // Real shape seen live: "{Company} {Role} {Type} {Location} {time}" with no
  // "$" and no " · " — the role must not swallow "Internship Remote 2wk ago".
  const r = deriveRoleAndComp('Rubbl', 'Rubbl Software Engineering Intern Internship Remote 2wk ago', 'Remote');
  assert.strictEqual(r.role, 'Software Engineering Intern');
  assert.strictEqual(r.comp, '');
});

test('deriveRoleAndComp chops tail with a multi-word location', () => {
  const r = deriveRoleAndComp('Novora Mgt.', 'Novora Mgt. AI Software Engineer Intern Internship Austin, TX 5d ago', 'Austin, TX');
  assert.strictEqual(r.role, 'AI Software Engineer Intern');
});

test('deriveRoleAndComp does NOT chop a well-formed card even if location passed', () => {
  // A card WITH a pay boundary must be untouched by the fallback cleanup.
  const r = deriveRoleAndComp('Goalbound', 'Goalbound Software Engineering Internship $25/hr · Internship · Jun 14—Jul 30 Remote 3d ago', 'Remote');
  assert.strictEqual(r.role, 'Software Engineering Internship');
  assert.strictEqual(r.comp, '$25/hr');
});

test('deriveLocation parses footer, dropping Promoted and time-ago', () => {
  assert.strictEqual(deriveLocation('Promoted∙Melrose, MA∙3wk ago'), 'Melrose, MA');
  assert.strictEqual(deriveLocation('Remote∙3d ago'), 'Remote');
  assert.strictEqual(deriveLocation('Remote or San Jose, CA∙2mo ago'), 'Remote or San Jose, CA');
});

test('deriveLocation returns empty string when footer yields nothing usable', () => {
  assert.strictEqual(deriveLocation('5d ago'), '');
});

test('deriveRoleAndComp does not strip a mid-word company prefix (word boundary)', () => {
  // logo-alt "Fenix Commerc" is a mid-word prefix of "Fenix Commerce ..." —
  // must NOT slice, or the role would start with a stray "e".
  const r = deriveRoleAndComp('Fenix Commerc', 'Fenix Commerce Software Engineer Intern $20/hr · Internship · Remote 1d ago');
  assert.ok(!r.role.startsWith('e '), `role should not start with a fragment: ${r.role}`);
});

test('deriveLocation strips verbose relative-time variants', () => {
  assert.strictEqual(deriveLocation('New York, NY∙3 days ago'), 'New York, NY');
  assert.strictEqual(deriveLocation('Boston, MA∙2 hr ago'), 'Boston, MA');
  assert.strictEqual(deriveLocation('Austin, TX∙1 week ago'), 'Austin, TX');
});

test('deriveLocation also splits the U+00B7 middle-dot footer variant', () => {
  // Defensive: if a card renders "·" (U+00B7) instead of "∙" (U+2219), the
  // footer must still split rather than dumping the whole string as location.
  assert.strictEqual(deriveLocation('Promoted·San Francisco, CA·2 days ago'), 'San Francisco, CA');
});

console.log('\n── HTML decode tests ─────────────────────────────────────');

test('stripHtml decodes entities in a Greenhouse-style title', () => {
  assert.strictEqual(stripHtml('Data Science Intern &#8211; Summer 2026 &amp; Beyond'), 'Data Science Intern – Summer 2026 & Beyond');
});

console.log('\n── SimplifyJobs title emoji tests ────────────────────────');

test('Emoji badges are stripped from SimplifyJobs titles', () => {
  assert.strictEqual(stripEmojiPrefix('Research Intern - SDN Traffic Intelligence & Control 🎓').trim(), 'Research Intern - SDN Traffic Intelligence & Control');
  assert.strictEqual(stripEmojiPrefix('Software Engineer Intern 🛂🇺🇸').trim(), 'Software Engineer Intern');
});

console.log('\n── SimplifyJobs row parser tests ─────────────────────────');

test('parseRows: extracts a row and prefers the direct ATS link over the simplify fallback', () => {
  // Mirrors the exact cell shape used in both README.md and README-Off-Season.md:
  // the Apply cell holds the direct ATS link first, then a simplify.jobs fallback.
  // The off-season fix relies on parseRows picking the direct link so the ATS
  // adapter (here Rippling) can discover + poll the board — this is that contract.
  const html = `
<tr>
<td><strong><a href="https://rippling.com">Rippling</a></strong></td>
<td>Software Engineer Intern - Backend Focused - Winter 2027</td>
<td>New York, NY</td>
<td><div align="center"><a href="https://ats.rippling.com/rippling/jobs/35b3ba25-ff2e-4b68-a2d7-61be26f2b24a?utm_source=Simplify&ref=Simplify"><img src="x.png" width="50" alt="Apply"></a> <a href="https://simplify.jobs/p/0d8819e9?utm_source=GHList"><img src="y.png" width="26" alt="Simplify"></a></div></td>
<td>0d</td>
</tr>`;
  const rows = parseRows(html);
  assert.strictEqual(rows.length, 1, 'should parse exactly one row');
  assert.strictEqual(rows[0].company, 'Rippling');
  assert.strictEqual(rows[0].title, 'Software Engineer Intern - Backend Focused - Winter 2027');
  assert.strictEqual(rows[0].location, 'New York, NY');
  assert.ok(
    rows[0].link.startsWith('https://ats.rippling.com/rippling/jobs/35b3ba25'),
    `expected the direct ATS link, got ${rows[0].link}`,
  );
});

test('parseRows: skips the header row and multi-location continuation (↳) rows', () => {
  const html = `
<tr><td>Company</td><td>Role</td><td>Location</td><td>Application</td></tr>
<tr><td><strong><a href="https://x">↳</a></strong></td><td>Extra Loc Intern</td><td>Austin, TX</td><td><a href="https://boards.greenhouse.io/acme/jobs/1">Apply</a></td></tr>`;
  assert.strictEqual(parseRows(html).length, 0, 'header + ↳ continuation rows must be dropped');
});

console.log('\n── Season expiry tests ───────────────────────────────────');

test('parseSeason: distributes a shared year across an adjacent season run', () => {
  // The year binds to every season in the run, not just the nearest — otherwise
  // "Fall / Winter 2026" looks like winter-2026-only and gets wrongly expired.
  assert.deepStrictEqual(parseSeason('Intern (Fall / Winter 2026)').sort(), ['fall-2026', 'winter-2026']);
  assert.deepStrictEqual(parseSeason('Co-op (Summer/Fall 2026)').sort(), ['fall-2026', 'summer-2026']);
  // Single-season titles are unchanged.
  assert.deepStrictEqual(parseSeason('Intern - Summer 2026'), ['summer-2026']);
  // Separate season-year pairs each keep their own year.
  assert.deepStrictEqual(parseSeason('Fall 2026 / Spring 2027').sort(), ['fall-2026', 'spring-2027']);
});

test('isExpiredSeasonTitle: drops past cycles, keeps current + future', () => {
  // Pin "now" to 2026-06-05 (summer-2026 cycle) so the test is deterministic.
  const now = new Date('2026-06-05T00:00:00Z');
  const exp = (t: string) => isExpiredSeasonTitle(t, now);
  // Exactly the stale chips that appeared after pulling in the off-season list.
  assert.strictEqual(exp('SWE Intern - Summer 2023'), true);
  assert.strictEqual(exp('SWE Intern - Summer 2025'), true);
  assert.strictEqual(exp('Intern - Embedded Software Engineer (Fall 2025)'), true);
  assert.strictEqual(exp('Software Engineering Intern - Winter 2026'), true);
  assert.strictEqual(exp('Network Software Intern - Spring 2026'), true);
  // Current + future must survive — incl. the Rippling Winter-2027 role that started this.
  assert.strictEqual(exp('Software Engineer Intern - Summer 2026'), false, 'current summer cycle');
  assert.strictEqual(exp('Software Engineer Intern - Fall 2026'), false);
  assert.strictEqual(exp('Full Stack Software Engineer Intern - Winter 2027'), false);
  // No season info → resolves to current default cycle → never expired.
  assert.strictEqual(exp('Software Engineer Intern'), false);
  // Multi-season posting survives if ANY token is current/future.
  assert.strictEqual(exp('Co-op - Fall 2025 / Spring 2027'), false);
});

test('applyHardFilters: rejects expired-season SWE roles, keeps far-future ones', () => {
  // Ancient/far-future years keep this independent of when the test runs.
  const expired = applyHardFilters({ title: 'Software Engineer Intern - Summer 2020', location: 'Remote in USA' });
  assert.strictEqual(expired.passed, false);
  assert.strictEqual(expired.reason, 'expired_season');
  const future = applyHardFilters({ title: 'Software Engineer Intern - Summer 2099', location: 'Remote in USA' });
  assert.strictEqual(future.passed, true, 'a far-future SWE intern role must pass');
});

// ==============================================================
// Run and report
// ==============================================================

(async () => {
  await runDedupTests();
  await runArchiveTests();
  await runApplicationTrackingTests();
  await runApiTests();
  await runSourceHealthApiTests();
  await runScoreBreakdownApiTests();

  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`${passed}/${total} tests passed`);
  if (passed < total) process.exit(1);
})();
