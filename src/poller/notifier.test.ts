import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isFreshEnough } from './notifier';

describe('notifier freshness', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  test('postings the source dates more than 14 days ago are not announced', () => {
    assert.equal(isFreshEnough({ postedAt: '2026-09-10' }, now), true);
    assert.equal(isFreshEnough({ postedAt: '2026-08-01' }, now), false);
  });
  test('an undated posting is treated as new', () => {
    assert.equal(isFreshEnough({ postedAt: undefined }, now), true);
  });
});
