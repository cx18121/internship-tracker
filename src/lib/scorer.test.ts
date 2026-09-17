import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scoreInternship, listedCompanyTier, labelFor, loadConfig, type ScoringConfig } from './scorer';

describe('Scorer', () => {
  test('SWE intern at an elite company lands in A', () => {
    const r = scoreInternship({ title: 'Software Engineer Intern', company: 'Anthropic', location: 'San Francisco, CA' });
    assert.equal(r.companyTier, 'elite');
    assert.equal(r.roleType, 'swe');
    assert.equal(r.score, 100);
    assert.equal(r.scoreLabel, 'A');
  });

  test('SWE intern at an unlisted company is a B, not an F', () => {
    const r = scoreInternship({ title: 'Software Engineer Intern', company: 'Unheard Of Labs', location: '' });
    assert.equal(r.companyTier, 'other');
    assert.equal(r.score, 60);
    assert.equal(r.scoreLabel, 'B');
  });

  test('classifier role type overrides the title keywords', () => {
    const r = scoreInternship({ title: 'Engineering Intern (Summer 2027)', company: 'Decagon', location: 'San Francisco', roleType: 'swe', companyTier: 'hot' });
    assert.equal(r.breakdown.role, 60);
    assert.equal(r.breakdown.company, 30);
    assert.equal(r.scoreLabel, 'A');
  });

  test('curated company tier beats the classifier tier', () => {
    const r = scoreInternship({ title: 'Software Engineer Intern', company: 'Anthropic', location: '', companyTier: 'other' });
    assert.equal(r.companyTier, 'elite');
  });

  test('a listed company name is recorded in matchedKeywords', () => {
    const r = scoreInternship({ title: 'Software Engineer Intern', company: 'Snowflake', location: '' });
    assert.ok(r.matchedKeywords.some(k => k.toLowerCase() === 'snowflake'));
  });

  test('every matching title keyword feeds matchedKeywords', () => {
    const r = scoreInternship({ title: 'Full Stack Software Engineer Intern', company: '', location: '' });
    assert.ok(r.matchedKeywords.includes('software engineer'));
    assert.ok(r.matchedKeywords.includes('full stack'));
  });

  test('title with no role keywords and no classifier → other → 0', () => {
    const r = scoreInternship({ title: 'Summer Intern', company: '', location: '' });
    assert.equal(r.roleType, 'other');
    assert.equal(r.score, 0);
    assert.equal(r.scoreLabel, 'F');
  });

  test('score is capped at the ceiling', () => {
    const r = scoreInternship({ title: 'Software Engineer Intern', company: 'Anthropic', location: 'New York', roleType: 'swe', companyTier: 'elite' });
    assert.equal(r.score, 100);
  });

  test('labels: 75 A, 60 B, 45 C, 25 D, else F', () => {
    assert.deepEqual([100, 75, 74, 60, 59, 45, 44, 25, 24, 0].map(labelFor), ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
  });

  test('curated names match the whole canonical company name only', () => {
    assert.equal(listedCompanyTier('Snap')?.name.toLowerCase(), 'snap');
    assert.equal(listedCompanyTier('Snap Finance'), null);
    assert.equal(listedCompanyTier('Sierra Nevada'), null);
    assert.equal(listedCompanyTier('Black Box'), null);
    assert.equal(listedCompanyTier('Two Sigma')?.tier, 'elite');
  });

  test('injected config drives scoring without touching disk', () => {
    const synthetic: ScoringConfig = {
      scoringCeiling: 100,
      roleBase: { swe: 42, ml_ai: 0, data: 0, quant: 0, hardware_ee: 0, research_science: 0, product_pm: 0, other: 0 },
      companyLift: { elite: 0, top: 0, hot: 0, solid: 0, other: 0 },
      companyTiers: {},
      roleTiers: { T1: { keywords: ['unicorn engineer'] } },
      roleTierFallback: { T1: 'swe' },
      locationBonus: {},
    };
    const r = scoreInternship({ title: 'Unicorn Engineer Intern', company: '', location: '' }, synthetic);
    assert.equal(r.score, 42);
    assert.deepEqual(r.matchedKeywords, ['unicorn engineer']);
  });
});

describe('Scoring config integrity', () => {
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'scoring-config.json'), 'utf-8')) as ScoringConfig;

  test('has every field the scorer reads', () => {
    for (const field of ['scoringCeiling', 'roleBase', 'companyLift', 'companyTiers', 'roleTiers', 'roleTierFallback', 'locationBonus'] as const) {
      assert.ok(field in config, `missing ${field}`);
    }
    assert.equal(config.scoringCeiling, 100);
  });

  test('a SWE role at an unlisted company is a B and at an elite one an A', () => {
    assert.ok(config.roleBase.swe >= 60);
    assert.ok(config.roleBase.swe + config.companyLift.elite >= 75);
    assert.ok(config.companyLift.elite > config.companyLift.top);
    assert.ok(config.companyLift.hot > config.companyLift.solid);
  });

  test('every legacy role tier maps to a role type', () => {
    for (const tier of Object.keys(config.roleTiers)) assert.ok(config.roleTierFallback[tier], `no fallback for ${tier}`);
  });

  test('curated company lists have no duplicates across tiers', () => {
    const seen = new Set<string>();
    for (const tier of Object.values(config.companyTiers)) {
      for (const c of tier?.companies ?? []) {
        assert.ok(!seen.has(c.toLowerCase()), `duplicate company: ${c}`);
        seen.add(c.toLowerCase());
      }
    }
  });

  test('loadConfig reads the same file', () => {
    assert.equal(loadConfig().scoringCeiling, config.scoringCeiling);
  });
});
