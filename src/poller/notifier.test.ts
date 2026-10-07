import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isFreshEnough, notificationLocations } from './notifier';

describe('notifier locations', () => {
  test('short location lists remain complete', () => {
    assert.equal(notificationLocations({ locations: ['NYC', 'SF'], location: 'NYC' }), 'NYC\nSF');
    assert.equal(notificationLocations({ locations: [], location: '' }), 'Unknown');
    assert.equal(notificationLocations({ locations: ['', ' '], location: ' ' }), 'Unknown');
  });
  test('long lists use whole lines and an accurate remaining-location count', () => {
    const locations = Array.from({ length: 60 }, (_, n) => `United States - California - Office ${n}`);
    const value = notificationLocations({ locations, location: locations[0] });
    assert.ok(value.length <= 1024);
    const lines = value.split('\n');
    assert.deepEqual(lines.slice(0, -1), locations.slice(0, lines.length - 1));
    assert.equal(lines.at(-1), `… (+${60 - lines.length + 1} more)`);
  });
  test('one oversized label stays within the limit without splitting an emoji', () => {
    const value = notificationLocations({ locations: ['😀'.repeat(1000)], location: '' });
    assert.ok(value.length <= 1024);
    assert.ok(!/[\uD800-\uDBFF]…$/.test(value));
  });
});

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
