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

// ==============================================================
// 2. Scorer tests
// ==============================================================

console.log('\n── Scorer tests ──────────────────────────────────────────');

// T1(4) + typescript(3) + python(3) + rag(3) + postgresql(3) + remote(2) = 18 → 100
test('T1 role + strong tech stack + Remote → Excellent (>= 85)', () => {
  const r = scoreInternship({
    title: 'Software Engineer Intern TypeScript Python RAG PostgreSQL',
    company: 'Anthropic',
    location: 'Remote',
  });
  assert.ok(r.score >= 85, `Expected >= 85, got ${r.score}`);
  assert.strictEqual(r.scoreLabel, 'Excellent');
});

// T2(3) + python(2)+docker(1)+sql(1)=4 capped + preferred(1) = 8 → 80 → Strong (ceiling=10)
test('T2 role + tech keywords + preferred city → Strong (no company prestige)', () => {
  const r = scoreInternship({
    title: 'Data Engineer Intern Python Docker SQL',
    company: 'TechCorp',
    location: 'New York',
  });
  assert.ok(r.score >= 70 && r.score <= 90, `Expected 70–90, got ${r.score}`);
  assert.strictEqual(r.scoreLabel, 'Strong', `Expected Strong, got ${r.scoreLabel}`);
});

// No matching keywords → raw 0 → score 0 → Low
test('No tech match, generic location → Low (<= 30)', () => {
  const r = scoreInternship({
    title: 'General Business Intern',
    company: 'Corp LLC',
    location: 'Columbus, OH',
  });
  assert.ok(r.score <= 30, `Expected <= 30, got ${r.score}`);
  assert.strictEqual(r.scoreLabel, 'Low');
});

// "finance intern" hits penalty(-2), raw max is -2 → floored at 0
test('Penalty keyword (Finance Intern) → score floored at 0', () => {
  const r = scoreInternship({
    title: 'Finance Intern with some coding experience',
    company: 'Goldman Sachs',
    location: 'New York',
  });
  assert.ok(r.score >= 0, `Score must not be negative, got ${r.score}`);
});

// elite(8) + T1(4) + tech capped(4) + domain signals(3) + remote(2) = 21 → 100
test('Max raw score → finalScore = 100', () => {
  const r = scoreInternship({
    title: 'Software Engineer Intern TypeScript Python RAG PostgreSQL',
    company: 'Anthropic AI',
    location: 'Remote',
    description: 'generative ai open source observability platform',
  });
  assert.strictEqual(r.score, 100);
});

// Completely empty internship → score 0
test('Zero raw score → finalScore = 0', () => {
  const r = scoreInternship({ title: '', company: '', location: '' });
  assert.strictEqual(r.score, 0);
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

  await testAsync('GET /api/internships → response has data array with required fields', async () => {
    const res = await fetch(base);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as { data: Internship[]; count: number };
    assert.ok(Array.isArray(body.data), 'body.data should be an array');
    if (body.data.length > 0) {
      const item = body.data[0];
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
    const body = await res.json() as { data: Internship[] };
    assert.ok(Array.isArray(body.data));
    for (const item of body.data) {
      assert.ok((item.score ?? 0) >= 70, `Item "${item.title}" has score ${item.score} < 70`);
    }
  });

  await testAsync('GET /api/internships?label=Excellent → all items have scoreLabel=Excellent', async () => {
    const res = await fetch(`${base}?label=Excellent`);
    assert.ok(res.ok, `HTTP ${res.status}`);
    const body = await res.json() as { data: Internship[] };
    assert.ok(Array.isArray(body.data));
    for (const item of body.data) {
      assert.strictEqual(item.scoreLabel, 'Excellent', `Item "${item.title}" has label ${item.scoreLabel}`);
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

  // Top-level required fields
  for (const field of ['scoringCeiling', 'companyTiers', 'techStackCap', 'roleTiers', 'techStack', 'domainSignals', 'locationBonus', 'penalties']) {
    assert.ok(field in config, `Missing top-level field: ${field}`);
  }

  // scoringCeiling must be 21
  assert.strictEqual(config.scoringCeiling, 10, `scoringCeiling should be 10, got ${config.scoringCeiling}`);

  // companyTiers must have elite and top
  assert.ok('elite' in config.companyTiers, 'companyTiers must have elite tier');
  assert.ok('top' in config.companyTiers, 'companyTiers must have top tier');
  assert.ok(Array.isArray(config.companyTiers.elite.companies), 'elite.companies must be an array');
  assert.ok(Array.isArray(config.companyTiers.top.companies), 'top.companies must be an array');

  // techStackCap must be a number
  assert.strictEqual(typeof config.techStackCap, 'number', 'techStackCap must be a number');

  // roleTiers must have T1, T2, T3 with keywords arrays
  for (const tier of ['T1', 'T2', 'T3']) {
    assert.ok(tier in config.roleTiers, `Missing role tier: ${tier}`);
    assert.ok(Array.isArray(config.roleTiers[tier].keywords), `${tier}.keywords must be an array`);
    assert.ok(config.roleTiers[tier].keywords.length > 0, `${tier}.keywords must not be empty`);
  }

  // techStack must have high, medium, low tiers with keywords arrays
  for (const level of ['high', 'medium', 'low']) {
    assert.ok(level in config.techStack, `Missing techStack tier: ${level}`);
    assert.ok(Array.isArray(config.techStack[level].keywords), `techStack.${level}.keywords must be an array`);
  }

  // domainSignals, locationBonus, penalties
  assert.ok(Array.isArray(config.domainSignals.keywords), 'domainSignals.keywords must be an array');
  assert.ok(Array.isArray(config.penalties.keywords), 'penalties.keywords must be an array');
  assert.ok('remote' in config.locationBonus, 'locationBonus must have remote');
  assert.ok('preferred' in config.locationBonus, 'locationBonus must have preferred');
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

test('ats-discovery: non-ATS URL returns null', () => {
  const target = discoverATSTarget('https://linkedin.com/jobs/view/123', 'Some Company');
  assert.strictEqual(target, null, 'Non-ATS URL should return null');
});

// ==============================================================
// 7. Archive stale postings test
// ==============================================================

async function runArchiveTests(): Promise<void> {
  console.log('\n── Archive tests ─────────────────────────────────────────');

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
    const archived = archiveStalePostings();
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
    const patched = patchInternship(testId, {
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
    const listBody = await listRes.json() as { data: Internship[] };
    assert.ok(listBody.data.length > 0, 'Need at least 1 internship for score-breakdown test');

    const id = listBody.data[0].id;
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
