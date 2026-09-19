import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { needsCheck } from './link-health';
import type { StoredInternship } from '../lib/types';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-16T12:00:00Z');
const row = (over: Partial<StoredInternship>): StoredInternship => ({
  id: 'x', title: 'T', company: 'C', location: 'L', locations: ['L'], link: 'https://x', source: 'SimplifyJobs',
  postedAt: '', seenAt: '', firstSeenAt: '', archived: false,
  failedCheckCount: 0, normalizedKey: '', season: [], ...over,
});

describe('needsCheck', () => {
  test('polled boards never need a direct check; feeds do after the TTL', () => {
    assert.equal(needsCheck(row({ source: 'Greenhouse' }), now), false);
    assert.equal(needsCheck(row({}), now), true);
    assert.equal(needsCheck(row({ lastCheckedAt: new Date(now - 2 * DAY).toISOString() }), now), false);
    assert.equal(needsCheck(row({ lastCheckedAt: new Date(now - 8 * DAY).toISOString() }), now), true);
  });
});
