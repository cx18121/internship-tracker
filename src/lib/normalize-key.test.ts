import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey } from './normalize-key';

describe('normalizeKey', () => {
  test('normalizeKey: collapses cross-source noise but keeps distinguishing terms', () => {
    const decorated = normalizeKey('Stripe', 'Software Engineer Intern, Summer 2025 (Remote)');
    assert.equal(decorated, 'stripe::software engineer', 'season/location/parenthetical/intern noise must be stripped');
    assert.equal(
      normalizeKey('Stripe', 'Software Engineer Intern'),
      decorated,
      'the same role from a cleaner source must produce the same key so cross-source dedup merges them',
    );
    assert.notEqual(
      normalizeKey('Stripe', 'Backend Engineer Intern'),
      decorated,
      'a genuinely different role at the same company must NOT collapse into the same key',
    );
    assert.notEqual(
      normalizeKey('Stripe', 'Frontend Engineer Intern'),
      normalizeKey('Stripe', 'Backend Engineer Intern'),
      'Frontend vs Backend are distinct roles and must stay distinct',
    );
  });
});
