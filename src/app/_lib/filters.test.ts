import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFilters, DEFAULT_FILTERS, type Filters } from './filters';
import type { Internship } from './types';

const item = (over: Partial<Internship> & { id: string }): Internship => ({
  title: 'SWE', company: 'C', location: 'L', link: `https://x/${over.id}`, source: 'X',
  postedAt: '2026-01-01', seenAt: '2026-01-01', score: 0, scoreLabel: null,
  matchedKeywords: [], applied: false, hidden: false, season: ['summer-2027'],
  ...over,
});

const ids = (items: Internship[], f: Partial<Filters>, sortBy: 'score' | 'posted' = 'score') =>
  evaluateFilters(items, { ...DEFAULT_FILTERS, ...f }, sortBy).filtered.map(i => i.id);

describe('filter-pipeline (evaluateFilters)', () => {
  test('minScore + source gate, score-desc order', () => {
    const corpus = [
      item({ id: 'a', company: 'A', location: 'NYC', source: 'Greenhouse', score: 90 }),
      item({ id: 'b', company: 'B', location: 'NYC', source: 'Indeed',     score: 40 }),
      item({ id: 'c', company: 'C', location: 'NYC', source: 'Greenhouse', score: 70 }),
    ];
    // Indeed row excluded by source; score-40 row excluded by minScore;
    // remaining ordered score-desc.
    assert.deepEqual(ids(corpus, { sources: ['Greenhouse'], minScore: 50 }), ['a', 'c']);
  });

  test('search matches company/title/location, hidden excluded unless showHidden', () => {
    const corpus = [
      item({ id: 'a', title: 'Backend Intern', company: 'Acme', location: 'NYC', score: 50 }),
      item({ id: 'b', title: 'Frontend Intern', company: 'Beta', location: 'SF', score: 60, hidden: true }),
    ];
    // Search "acme" hits company on row a only.
    assert.deepEqual(ids(corpus, { q: 'acme', showHidden: false }), ['a']);
    // Hidden row b is excluded by default, included when showHidden.
    assert.deepEqual(ids(corpus, { q: '', showHidden: false }), ['a']);
    assert.deepEqual(ids(corpus, { q: '', showHidden: true }).sort(), ['a', 'b']);
  });

  test('sortBy posted orders by postedAt desc', () => {
    const corpus = [
      item({ id: 'old', title: 'T', score: 99, postedAt: '2026-01-01' }),
      item({ id: 'new', title: 'T', score: 10, postedAt: '2026-05-01' }),
    ];
    assert.deepEqual(ids(corpus, {}, 'posted'), ['new', 'old']); // newest first, ignores score
  });

  test('search and location branches', () => {
    const corpus = [item({ id: 'r', company: 'Acme', title: 'Backend Intern', location: 'New York, NY' })];
    // No predicates → passes.
    assert.deepEqual(ids(corpus, {}), ['r']);
    // Search matches title (case-insensitive), fails when absent.
    assert.deepEqual(ids(corpus, { q: 'backend' }), ['r']);
    assert.deepEqual(ids(corpus, { q: 'frontend' }), []);
    // locationText substring: 'york' matches, 'boston' does not.
    assert.deepEqual(ids(corpus, { locationText: 'york' }), ['r']);
    assert.deepEqual(ids(corpus, { locationText: 'boston' }), []);
    // locations: a matching chip passes, a non-matching chip fails.
    assert.deepEqual(ids(corpus, { locations: ['new york'] }), ['r']);
    assert.deepEqual(ids(corpus, { locations: ['remote'] }), []);
  });
});
