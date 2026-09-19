import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scoreInternship, listedCompanyTier, labelFor, loadConfig, type ScoringConfig } from './scorer';

describe('Scorer', () => {
  test('SWE intern at an elite company is an A', () => {
    const r = scoreInternship({ title: 'Software Engineer Intern', company: 'Anthropic', location: 'San Francisco, CA' });
    assert.equal(r.companyTier, 'elite');
    assert.equal(r.roleType, 'swe');
    assert.equal(r.score, 100);
    assert.equal(r.scoreLabel, 'A');
  });

  test('the company sets the band; the role scales it', () => {
    const at = (companyTier: 'elite' | 'hot' | 'top' | 'solid' | 'other', roleType: 'swe' | 'it_security' | 'hardware_ee') =>
      scoreInternship({ title: 'Intern', company: 'X', location: '', companyTier, roleType }).score;
    assert.equal(at('elite', 'swe'), 100);
    assert.equal(at('hot', 'swe'), 85);
    assert.equal(at('top', 'swe'), 70);
    assert.equal(at('solid', 'swe'), 45);
    assert.equal(at('other', 'swe'), 30);
    assert.equal(at('top', 'it_security'), 42, 'a security analyst at a top company is a D');
    assert.equal(at('elite', 'hardware_ee'), 50);
  });

  test('classifier role type overrides the title keywords', () => {
    const r = scoreInternship({ title: 'Engineering Intern (Summer 2027)', company: 'Decagon', location: 'San Francisco', roleType: 'swe', companyTier: 'hot' });
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

  test('title with no role keywords and no classifier → other → 0, no location bonus', () => {
    const r = scoreInternship({ title: 'Summer Intern', company: 'Anthropic', location: 'New York' });
    assert.equal(r.roleType, 'other');
    assert.equal(r.score, 0);
  });

  test('labels: 75 A, 60 B, 45 C, 25 D, else F', () => {
    assert.deepEqual([100, 75, 74, 60, 59, 45, 44, 25, 24, 0].map(labelFor), ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
  });

  test('curated names match the whole canonical company name only', () => {
    assert.equal(listedCompanyTier('Snap')?.name.toLowerCase(), 'snap');
    assert.equal(listedCompanyTier('Snap Finance'), null);
    assert.equal(listedCompanyTier('Sierra Nevada'), null);
    assert.equal(listedCompanyTier('Two Sigma')?.tier, 'elite');
  });

  test('injected config drives scoring without touching disk', () => {
    const synthetic: ScoringConfig = {
      scoringCeiling: 100,
      companyBase: { elite: 0, hot: 0, top: 0, solid: 0, other: 42 },
      roleMultiplier: { swe: 1, ml_ai: 0, data: 0, quant: 0, it_security: 0, hardware_ee: 0, research_science: 0, product_pm: 0, other: 0 },
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
    for (const field of ['scoringCeiling', 'companyBase', 'roleMultiplier', 'companyTiers', 'roleTiers', 'roleTierFallback', 'locationBonus'] as const) {
      assert.ok(field in config, `missing ${field}`);
    }
    assert.equal(config.scoringCeiling, 100);
  });

  test('elite and hot SWE roles are A, top is B, solid is C, unlisted is D', () => {
    for (const t of ['elite', 'hot'] as const) assert.ok(config.companyBase[t] * config.roleMultiplier.swe >= 75, t);
    assert.ok(config.companyBase.top * config.roleMultiplier.swe >= 60 && config.companyBase.top * config.roleMultiplier.swe < 75);
    assert.ok(config.companyBase.solid * config.roleMultiplier.swe < 60);
    assert.ok(config.companyBase.other * config.roleMultiplier.swe < 45);
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

describe('present', () => {
  test('derives score, tier, metros, and open seasons from stored facts', async () => {
    const { present } = await import('./present');
    const row = present({
      id: 'x', title: 'Software Engineer Intern', company: 'Anthropic', location: 'SF', locations: ['SF', 'New York, NY'], link: 'https://x', source: 'Greenhouse',
      seenAt: '2026-09-17T00:00:00Z', firstSeenAt: '2026-09-17T00:00:00Z', archived: false, failedCheckCount: 0, normalizedKey: 'anthropic::software engineer',
      season: ['summer-2026', 'summer-2027'], roleType: 'swe', companyTier: 'other',
    }, new Date('2026-09-17T00:00:00Z'));
    assert.equal(row.companyTier, 'elite', 'curated list overrides the joined tier');
    assert.equal(row.score, 100);
    assert.deepEqual(row.metros, ['bay', 'nyc']);
    assert.deepEqual(row.season, ['summer-2027'], 'expired tokens are dropped on read');
  });
});
