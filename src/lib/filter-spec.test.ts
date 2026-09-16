import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilterSpec, type Filterable } from './filter-spec';

describe('applyFilterSpec', () => {
  test('applyFilterSpec: season gate honors the i.season token', () => {
    const base: Filterable = {
      title: 'SWE Intern', company: 'Acme', source: 'Greenhouse', score: 90,
      applied: false, hidden: false, season: ['summer-2027'],
    };
    assert.equal(
      applyFilterSpec({ ...base, season: ['fall-2026'] }, { seasons: ['fall-2026'] }), true,
      'explicit season token in the allowlist passes',
    );
    assert.equal(
      applyFilterSpec({ ...base, season: ['fall-2026'] }, { seasons: ['summer-2027'] }), false,
      'explicit season token outside the allowlist fails',
    );
    assert.equal(applyFilterSpec(base, { appliedFilter: 'applied' }), false, 'unapplied posting fails an applied-only gate');
    assert.equal(applyFilterSpec(base, { excludeSources: ['Greenhouse'] }), false, 'excluded source fails');
    assert.equal(applyFilterSpec(base, { includeSources: ['Lever'] }), false, 'source not in the include list fails');
    assert.equal(applyFilterSpec(base, { minScore: 95 }), false, 'score below minScore fails');
    assert.equal(applyFilterSpec(base, {}), true, 'an empty spec gates nothing');
  });
});
