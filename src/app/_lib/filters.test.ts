import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFilters, DEFAULT_FILTERS, type Filters } from './filters';
import type { Internship } from './types';

const item = (over: Partial<Internship> & { id: string }): Internship => ({
  title: 'SWE', company: 'C', location: 'L', locations: [over.location ?? 'L'], metros: [], link: `https://x/${over.id}`, source: 'X',
  postedAt: '2026-01-01', seenAt: '2026-01-01', firstSeenAt: '2026-01-01', score: 0, scoreLabel: null,
  season: ['summer-2027'],
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

  test('search matches company, title, and location', () => {
    const corpus = [
      item({ id: 'a', title: 'Backend Intern', company: 'Acme', location: 'NYC', score: 50 }),
      item({ id: 'b', title: 'Frontend Intern', company: 'Beta', location: 'SF', score: 60 }),
    ];
    assert.deepEqual(ids(corpus, { q: 'acme' }), ['a']);
    assert.deepEqual(ids(corpus, { q: 'frontend' }), ['b']);
    assert.deepEqual(ids(corpus, { q: 'sf' }), ['b']);
  });

  test('metro chips match any listed metro and count the other chips', () => {
    const corpus = [
      item({ id: 'a', locations: ['SF', 'New York, NY'], metros: ['bay', 'nyc'] }),
      item({ id: 'b', locations: ['Austin, TX'], metros: ['austin'] }),
    ];
    assert.deepEqual(ids(corpus, { metros: ['nyc'] }), ['a']);
    const r = evaluateFilters(corpus, { ...DEFAULT_FILTERS, metros: ['austin'] }, 'score');
    assert.equal(r.metroCounts.bay, 1, 'metro counts ignore the metro filter itself');
    assert.deepEqual(ids(corpus, { locationText: 'york' }), ['a']);
  });

  test('type and degree chips gate on the classifier fields', () => {
    const corpus = [
      item({ id: 'a', roleType: 'swe', degrees: ['bs'] }),
      item({ id: 'b', roleType: 'hardware_ee', degrees: ['ms', 'phd'] }),
      item({ id: 'c', roleType: 'swe', degrees: [] }),
    ];
    assert.deepEqual(ids(corpus, { roleTypes: ['swe'] }).sort(), ['a', 'c']);
    assert.deepEqual(ids(corpus, { degrees: ['phd'] }), ['b']);
    assert.deepEqual(ids(corpus, { degrees: ['unknown'] }), ['c']);
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
  });
});
