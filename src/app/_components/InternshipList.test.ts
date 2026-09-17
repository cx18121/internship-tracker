import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupInternships } from './InternshipList';
import type { Internship } from '../_lib/types';

const item = (over: Partial<Internship> & { id: string }): Internship => ({
  title: 'T', company: 'C', location: 'L', link: `https://x/${over.id}`, source: 'X',
  postedAt: '2026-01-01', seenAt: '2026-01-01', score: 0, scoreLabel: null,
  season: ['summer-2027'],
  ...over,
});

describe('groupInternships', () => {
  test('groupInternships: score sort orders companies by avg score desc', () => {
    const corpus = [
      item({ id: 'a1', company: 'Acme', score: 80 }),
      item({ id: 'a2', company: 'Acme', score: 90 }),
      item({ id: 'b1', company: 'Beta', score: 95 }),
      item({ id: 'c1', company: 'Cyon', score: 50 }),
    ];
    const out = groupInternships(corpus, 'score');
    assert.deepEqual(out.map(g => g.company), ['Beta', 'Acme', 'Cyon']); // avg 95, 85, 50
    const acme = out.find(g => g.company === 'Acme')!;
    assert.equal(acme.avgScore, 85);
  });

  test('groupInternships: posted sort orders companies by newest posting, ignoring score', () => {
    const corpus = [
      item({ id: 'old', company: 'OldCo', score: 99, postedAt: '2026-01-01' }),
      item({ id: 'new', company: 'NewCo', score: 1,  postedAt: '2026-05-01' }),
    ];
    // Under "posted", NewCo ranks first because it posted more recently — NOT
    // OldCo, which would win on score. Company order follows the active sort.
    assert.deepEqual(groupInternships(corpus, 'posted').map(g => g.company), ['NewCo', 'OldCo']);
  });

  test('groupInternships: posted sort ranks a company by its most-recent role', () => {
    const corpus = [
      item({ id: 'x-feb', company: 'X', postedAt: '2026-02-01' }),
      item({ id: 'x-apr', company: 'X', postedAt: '2026-04-01' }),
      item({ id: 'y-mar', company: 'Y', postedAt: '2026-03-01' }),
    ];
    const out = groupInternships(corpus, 'posted');
    // X's newest role (Apr) beats Y's only role (Mar). A min/first-based ranking
    // would see X's first role (Feb) and flip the order — this asserts max-based.
    assert.deepEqual(out.map(g => g.company), ['X', 'Y']);
    // Roles within a group keep their incoming order (the caller pre-sorts the list).
    assert.deepEqual(out.find(g => g.company === 'X')!.items.map(i => i.id), ['x-feb', 'x-apr']);
  });

  test('groupInternships: blank company → "Unknown"; null postedAt sorts last under posted', () => {
    const corpus = [
      item({ id: 'k', company: 'Known', postedAt: '2026-05-01' }),
      item({ id: 'u', company: '',      postedAt: null as unknown as string }),
    ];
    // Empty company name buckets into "Unknown"; a null postedAt is treated as
    // epoch 0, so it ranks last under the posted sort.
    assert.deepEqual(groupInternships(corpus, 'posted').map(g => g.company), ['Known', 'Unknown']);
  });

  test('groupInternships: case-only company variants merge into one section', () => {
    // Ingestion canonicalizes legal suffixes but can't normalize intentional
    // casing, so "Quadric" and "QUADRIC" survive as distinct strings. Grouping
    // must still treat them as ONE company.
    const corpus = [
      item({ id: 'q1', company: 'Quadric', score: 80 }),
      item({ id: 'q2', company: 'QUADRIC', score: 90 }),
    ];
    const out = groupInternships(corpus, 'score');
    assert.equal(out.length, 1, 'casing variants must collapse to one group');
    assert.equal(out[0].items.length, 2);
    // Display picks the non-ALL-CAPS casing when counts tie.
    assert.equal(out[0].company, 'Quadric');
  });
});
