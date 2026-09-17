import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilterSpec, type Filterable } from './filter-spec';

describe('applyFilterSpec', () => {
  const base: Filterable = { title: 'SWE Intern', company: 'Acme', source: 'Greenhouse', score: 90, season: ['summer-2027'], companyTier: 'hot' };

  test('season gate honors the season tokens', () => {
    assert.equal(applyFilterSpec({ ...base, season: ['fall-2026'] }, { seasons: ['fall-2026'] }), true);
    assert.equal(applyFilterSpec({ ...base, season: ['fall-2026'] }, { seasons: ['summer-2027'] }), false);
  });

  test('source and score gates', () => {
    assert.equal(applyFilterSpec(base, { excludeSources: ['Greenhouse'] }), false);
    assert.equal(applyFilterSpec(base, { includeSources: ['Lever'] }), false);
    assert.equal(applyFilterSpec(base, { minScore: 95 }), false);
    assert.equal(applyFilterSpec(base, {}), true);
  });

  test('tier gate reads the judged company tier; hot counts as top', () => {
    assert.equal(applyFilterSpec(base, { tier: 'top-or-better' }), true);
    assert.equal(applyFilterSpec(base, { tier: 'elite' }), false);
    assert.equal(applyFilterSpec({ ...base, companyTier: undefined }, { tier: 'solid-or-better' }), false);
  });
});
