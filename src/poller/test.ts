import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { applyHardFilters } from './filter';
import { scoreInternship } from '../lib/scorer';
import { deduplicateAndStore, archiveStalePostings, getInternships, patchInternship, _deleteInternshipForTest } from '../lib/store';
import type { Internship } from '../lib/types';

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

// T1(40) + elite(55) + tech(11+ from Python/RAG/PostgreSQL in description) +
// preferred(6) = 100+ → clamp 100 → A
test('T1 role + elite company + strong tech in description → A', () => {
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

// Verify the config-injection seam: a synthetic config with a single role
// keyword and no other tiers should drive scoring entirely off the injected
// values, with no filesystem read.
test('scoreInternship accepts an injected config — exercises seam without touching disk', () => {
  const synthetic = {
    scoringCeiling: 100,
    companyTiers: {},
    roleTiers: { T1: { points: 42, keywords: ['unicorn engineer'] } },
    techStack: {},
    techStackCap: 0,
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
    scoreLabel: 'Good',
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
  _deleteInternshipForTest(testId);
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

  for (const field of ['scoringCeiling', 'companyTiers', 'techStackCap', 'roleTiers', 'techStack', 'locationBonus']) {
    assert.ok(field in config, `Missing top-level field: ${field}`);
  }

  assert.strictEqual(config.scoringCeiling, 100, `scoringCeiling should be 100, got ${config.scoringCeiling}`);

  assert.ok('elite' in config.companyTiers, 'companyTiers must have elite tier');
  assert.ok('top' in config.companyTiers, 'companyTiers must have top tier');
  assert.ok(Array.isArray(config.companyTiers.elite.companies), 'elite.companies must be an array');
  assert.ok(Array.isArray(config.companyTiers.top.companies), 'top.companies must be an array');
  assert.ok(config.companyTiers.elite.points > config.companyTiers.top.points,
    'elite should be worth more than top');

  assert.strictEqual(typeof config.techStackCap, 'number', 'techStackCap must be a number');

  for (const tier of ['T1', 'T2', 'T3']) {
    assert.ok(tier in config.roleTiers, `Missing role tier: ${tier}`);
    assert.ok(Array.isArray(config.roleTiers[tier].keywords), `${tier}.keywords must be an array`);
    assert.ok(config.roleTiers[tier].keywords.length > 0, `${tier}.keywords must not be empty`);
  }
  assert.ok(config.roleTiers.T1.points > config.roleTiers.T2.points, 'T1 > T2');
  assert.ok(config.roleTiers.T2.points > config.roleTiers.T3.points, 'T2 > T3');

  for (const level of ['high', 'medium', 'low']) {
    assert.ok(level in config.techStack, `Missing techStack tier: ${level}`);
    assert.ok(Array.isArray(config.techStack[level].keywords), `techStack.${level}.keywords must be an array`);
  }

  assert.ok('preferred' in config.locationBonus, 'locationBonus must have preferred');

  // domainSignals is optional but if present, must be well-formed
  if (config.domainSignals) {
    assert.ok(Array.isArray(config.domainSignals.keywords), 'domainSignals.keywords must be an array');
    assert.strictEqual(typeof config.domainSignals.pointsEach, 'number');
    assert.strictEqual(typeof config.domainSignals.cap, 'number');
  }

  // penalties and locationBonus.remote were removed — assert they are NOT present
  // (hard-filter in filter.ts handles non-SWE roles; remote is no longer a quality signal).
  assert.ok(!('penalties' in config), 'penalties section should be removed');
  assert.ok(!('remote' in config.locationBonus), 'locationBonus.remote should be removed');
});

// ==============================================================
// 6. ATS targets config integrity
// ==============================================================

console.log('\n── ATS targets config integrity ──────────────────────────');

import { discoverATSTarget } from '../lib/utils/ats-discovery';

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

import { smartTrimDescription, HANDSHAKE_PROMO_BANNER_SOURCE } from './utils/description-trim';

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

import { buildInternshipRow } from './utils/build-row';

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
      scoreLabel: 'Good',
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
    const withoutArchived = getInternships();
    const found1 = withoutArchived.find(i => i.id === testId);
    assert.strictEqual(found1, undefined, 'Archived internship should not appear without includeArchived');

    // With includeArchived: SHOULD find the test internship
    const withArchived = getInternships({ includeArchived: true });
    const found2 = withArchived.find(i => i.id === testId);
    assert.ok(found2, 'Archived internship should appear with includeArchived=true');
    assert.strictEqual(found2!.archived, true, 'archived flag should be true');

    // Cleanup
    _deleteInternshipForTest(testId);
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
      scoreLabel: 'Good',
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
    _deleteInternshipForTest(testId);
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
