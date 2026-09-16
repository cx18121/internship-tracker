import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { scoreInternship, type ScoringConfig } from './scorer';

describe('Scorer', () => {
  // T1(40) + elite(70) + preferred(6) → clamp 100 → A.
  test('T1 role + elite company + preferred location → A', () => {
    const r = scoreInternship({
      title: 'Software Engineer Intern',
      company: 'Anthropic',
      location: 'San Francisco, CA',
    });
    assert.ok(r.score >= 85, `Expected >= 85, got ${r.score}`);
    assert.equal(r.scoreLabel, 'A');
  });

  test('T2 role + top company + preferred city → B or A', () => {
    const r = scoreInternship({
      title: 'Data Engineer Intern',
      company: 'Snowflake',
      location: 'New York',
    });
    assert.ok(r.score >= 60 && r.score <= 100, `Expected 60–100, got ${r.score}`);
    assert.ok(r.scoreLabel === 'A' || r.scoreLabel === 'B', `Expected A or B, got ${r.scoreLabel}`);
  });

  test('No role/company match → F', () => {
    const r = scoreInternship({
      title: 'General Business Intern',
      company: 'Corp LLC',
      location: 'Columbus, OH',
    });
    assert.ok(r.score < 25, `Expected < 25, got ${r.score}`);
    assert.equal(r.scoreLabel, 'F');
  });

  // Score never goes negative — there is no penalty section (filter.ts handles exclusions).
  test('Bare T1 SWE intern → score = role tier only (40)', () => {
    const r = scoreInternship({
      title: 'Software Engineer Intern',
      company: 'Corp LLC',
      location: '',
    });
    assert.equal(r.score, 40);
  });

  test('Max raw score → finalScore clamped to 100', () => {
    const r = scoreInternship({
      title: 'Software Engineer Intern',
      company: 'Anthropic',
      location: 'San Francisco, CA',
    });
    assert.equal(r.score, 100);
  });

  test('Zero raw score → finalScore = 0', () => {
    const r = scoreInternship({ title: '', company: '', location: '' });
    assert.equal(r.score, 0);
  });

  // Keyword matching tokenizes + stems trailing -ing/-s so "engineering
  // intern" matches the "engineer intern" keyword.
  test('Morphology: "Engineering Intern" matches T3 "engineer intern"', () => {
    const r = scoreInternship({
      title: 'Undergrad Engineering Intern',
      company: 'Apple',
      location: 'United States',
    });
    // T3 (13) + elite Apple (70) = 83
    assert.equal(r.breakdown.role, 13, `expected role=13, got ${r.breakdown.role}`);
    assert.equal(r.score, 83, `expected 83, got ${r.score}`);
  });

  test('Morphology: "Software Engineering Intern" matches T1 "software engineer"', () => {
    const r = scoreInternship({
      title: 'Software Engineering Intern',
      company: 'Corp LLC',
      location: '',
    });
    assert.equal(r.breakdown.role, 40, `expected T1=40, got ${r.breakdown.role}`);
  });

  // Only role/company/location count; "backend" is a T1 keyword.
  test('Bare "Backend Intern" → T1 role tier only (40)', () => {
    const r = scoreInternship({
      title: 'Backend Intern',
      company: 'Corp LLC',
      location: '',
    });
    assert.equal(r.score, 40, `expected 40 (T1 only), got ${r.score}`);
  });

  test('Elite company worth 70 points', () => {
    const r = scoreInternship({
      title: 'Marketing Intern',  // no role match
      company: 'Apple',
      location: '',
    });
    assert.equal(r.breakdown.company, 70, `expected elite=70, got ${r.breakdown.company}`);
  });

  test('Top company worth 45 points', () => {
    const r = scoreInternship({
      title: 'Marketing Intern',  // no role match
      company: 'Coinbase',
      location: '',
    });
    assert.equal(r.breakdown.company, 45, `expected top=45, got ${r.breakdown.company}`);
  });

  // The 3rd tier ("solid") closes the cliff between top (45) and 0 so a T1
  // SWE at a known-but-not-top company lands in B (40 + 20 = 60).
  test('Solid (3rd-tier) company worth 20 points', () => {
    const r = scoreInternship({
      title: 'Marketing Intern',  // no role match
      company: 'Snyk',
      location: '',
    });
    assert.equal(r.breakdown.company, 20, `expected solid=20, got ${r.breakdown.company}`);
  });

  test('T1 SWE at solid company lands in B (cliff fix)', () => {
    const r = scoreInternship({
      title: 'Software Engineer Intern',
      company: 'Snyk',
      location: '',
    });
    // T1 (40) + solid (20) = 60 → B
    assert.equal(r.score, 60, `expected 60, got ${r.score}`);
    assert.equal(r.scoreLabel, 'B', `expected B, got ${r.scoreLabel}`);
  });

  // Single-token tier entries ("apple", "box", "meta") anchor to the START of
  // the company name so "Black Box Corp" doesn't match "box". Multi-token
  // entries keep substring-phrase semantics.
  test('Single-token tier entry anchors to start of company name', () => {
    // "box" is in solid (Box, the file storage company).
    const realBox = scoreInternship({ title: '', company: 'Box', location: '' });
    const realBoxInc = scoreInternship({ title: '', company: 'Box Inc', location: '' });
    const blackBox = scoreInternship({ title: '', company: 'Black Box Corp', location: '' });

    assert.equal(realBox.breakdown.company, 20, `"Box" should match solid, got ${realBox.breakdown.company}`);
    assert.equal(realBoxInc.breakdown.company, 20, `"Box Inc" should match solid, got ${realBoxInc.breakdown.company}`);
    assert.equal(blackBox.breakdown.company, 0, `"Black Box Corp" must NOT match, got ${blackBox.breakdown.company}`);
  });

  test('Multi-token tier entry still matches anywhere in company name', () => {
    // "two sigma" is in elite.
    const r = scoreInternship({ title: '', company: 'Two Sigma Investments LLC', location: '' });
    assert.equal(r.breakdown.company, 70, `"Two Sigma Investments" should match elite, got ${r.breakdown.company}`);
  });

  // Tier resolution order: elite > top > solid (elite is iterated first).
  test('Elite still wins over solid when company is in both lists', () => {
    const r = scoreInternship({
      title: 'Marketing Intern',
      company: 'Apple',
      location: '',
    });
    assert.equal(r.breakdown.company, 70, `elite should win, got ${r.breakdown.company}`);
  });

  // Config-injection seam: a synthetic config drives scoring entirely, with
  // no filesystem read.
  test('scoreInternship accepts an injected config — exercises seam without touching disk', () => {
    const synthetic: ScoringConfig = {
      scoringCeiling: 100,
      companyTiers: {},
      roleTiers: { T1: { points: 42, keywords: ['unicorn engineer'] } },
      locationBonus: {},
    };
    const r = scoreInternship({ title: 'Unicorn Engineer Intern', company: '', location: '' }, synthetic);
    assert.equal(r.score, 42, `injected role tier should drive the whole score, got ${r.score}`);
    assert.deepEqual(r.matchedKeywords, ['unicorn engineer']);
    assert.equal(r.breakdown.role, 42);
    assert.equal(r.breakdown.company, 0);
  });
});

describe('Scoring config integrity', () => {
  test('scoring-config.json has all required fields', () => {
    const configPath = path.join(process.cwd(), 'data', 'scoring-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    for (const field of ['scoringCeiling', 'companyTiers', 'roleTiers', 'locationBonus']) {
      assert.ok(field in config, `Missing top-level field: ${field}`);
    }

    assert.equal(config.scoringCeiling, 100, `scoringCeiling should be 100, got ${config.scoringCeiling}`);

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

    // Only role/company/location sections exist; description-derived and
    // penalty sections must not come back.
    assert.ok(!('techStack' in config), 'techStack section should be removed');
    assert.ok(!('techStackCap' in config), 'techStackCap should be removed');
    assert.ok(!('domainSignals' in config), 'domainSignals section should be removed');
    assert.ok(!('penalties' in config), 'penalties section should be removed');
    assert.ok(!('remote' in config.locationBonus), 'locationBonus.remote should be removed');
  });
});
