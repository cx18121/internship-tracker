import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scoreInternship, listedCompanyTier, labelFor, loadConfig, type ScoringConfig } from './scorer';

describe('Scorer', () => {
  const at = (companyTier: 'elite' | 'hot' | 'top' | 'startup' | 'solid' | 'other', roleType: 'swe' | 'data' | 'it_security' | 'hardware_ee', extra: Partial<Parameters<typeof scoreInternship>[0]> = {}) =>
    scoreInternship({ title: 'Intern', company: 'X', companyTier, roleType, inMetro: true, ...extra }).score;

  test('B or better means elite, hot, top, or startup in a software role', () => {
    assert.equal(at('elite', 'swe'), 100);
    assert.equal(at('hot', 'swe'), 90);
    assert.equal(at('top', 'swe'), 80);
    assert.equal(at('startup', 'swe'), 70);
    assert.equal(at('solid', 'swe'), 40, 'banks and insurers are backups');
    assert.equal(at('other', 'swe'), 25);
  });

  test('role scales the band; adjacent roles at great companies drop', () => {
    assert.equal(at('elite', 'hardware_ee'), 40);
    assert.equal(at('top', 'it_security'), 40);
    assert.equal(at('top', 'data'), 64);
  });

  test('outside the preferred metros costs one band', () => {
    assert.equal(at('startup', 'swe', { inMetro: false }), 56, 'startup SWE in Columbus is a C');
    assert.equal(at('elite', 'swe', { inMetro: false }), 80, 'elite stays A anywhere');
    assert.equal(at('startup', 'swe', { inMetro: undefined }), 70, 'unknown location is not penalized');
  });

  test('graduate-only roles are halved; PhD-preferred with bs eligible is not', () => {
    assert.equal(at('elite', 'swe', { degrees: ['phd'] }), 50);
    assert.equal(at('elite', 'swe', { degrees: ['ms', 'phd'] }), 50);
    assert.equal(at('elite', 'swe', { degrees: ['bs', 'ms', 'phd'] }), 100);
    assert.equal(at('elite', 'swe', { degrees: [] }), 100, 'no signal is not a penalty');
  });

  test('curated company tier beats the classifier tier', () => {
    const r = scoreInternship({ title: 'Software Engineer Intern', company: 'Anthropic', companyTier: 'other', roleType: 'swe' });
    assert.equal(r.companyTier, 'elite');
  });

  test('title keywords infer the role before classification', () => {
    const r = scoreInternship({ title: 'Software Engineer Intern', company: 'Anthropic' });
    assert.equal(r.roleType, 'swe');
    assert.equal(r.score, 100);
    assert.equal(scoreInternship({ title: 'Summer Intern', company: 'Anthropic' }).score, 0);
  });

  test('labels: 75 A, 60 B, 45 C, 25 D, else F', () => {
    assert.deepEqual([100, 75, 74, 60, 59, 45, 44, 25, 24, 0].map(labelFor), ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
  });

  test('curated names match the whole canonical company name only', () => {
    assert.equal(listedCompanyTier('Snap')?.name.toLowerCase(), 'snap');
    assert.equal(listedCompanyTier('Snap Finance'), null);
    assert.equal(listedCompanyTier('Two Sigma')?.tier, 'elite');
  });

  test('injected config drives scoring without touching disk', () => {
    const synthetic: ScoringConfig = {
      scoringCeiling: 100,
      companyBase: { elite: 0, hot: 0, top: 0, startup: 0, solid: 0, other: 42 },
      roleMultiplier: { swe: 1, ml_ai: 0, data: 0, quant: 0, it_security: 0, hardware_ee: 0, research_science: 0, product_pm: 0, other: 0 },
      outsideMetroMultiplier: 1,
      graduateOnlyMultiplier: 1,
      companyTiers: {},
      roleTiers: { T1: { keywords: ['unicorn engineer'] } },
      roleTierFallback: { T1: 'swe' },
    };
    const r = scoreInternship({ title: 'Unicorn Engineer Intern', company: '' }, synthetic);
    assert.equal(r.score, 42);
    assert.deepEqual(r.matchedKeywords, ['unicorn engineer']);
  });
});

describe('Scoring config integrity', () => {
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'scoring-config.json'), 'utf-8')) as ScoringConfig;

  test('has every field the scorer reads', () => {
    for (const field of ['scoringCeiling', 'companyBase', 'roleMultiplier', 'outsideMetroMultiplier', 'graduateOnlyMultiplier', 'companyTiers', 'roleTiers', 'roleTierFallback'] as const) {
      assert.ok(field in config, `missing ${field}`);
    }
    assert.equal(config.scoringCeiling, 100);
  });

  test('software roles at elite, hot, top, and startup are B or better; solid and other are not', () => {
    for (const t of ['elite', 'hot', 'top', 'startup'] as const) assert.ok(config.companyBase[t] * config.roleMultiplier.swe >= 60, t);
    for (const t of ['solid', 'other'] as const) assert.ok(config.companyBase[t] * config.roleMultiplier.swe < 60, t);
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
