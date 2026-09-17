import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkedInJobId, needsCheck } from './link-health';
import type { Internship } from '../lib/types';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-16T12:00:00Z');
const row = (over: Partial<Internship>): Internship => ({
  id: 'x', title: 'T', company: 'C', location: 'L', locations: ['L'], metros: [], link: 'https://x', source: 'SimplifyJobs',
  postedAt: '', seenAt: '', score: 0, scoreLabel: null, matchedKeywords: [], archived: false,
  failedCheckCount: 0, normalizedKey: '', season: [], ...over,
});

describe('extractLinkedInJobId', () => {
  test('reads both URL shapes and rejects other hosts', () => {
    assert.equal(extractLinkedInJobId('https://www.linkedin.com/jobs/view/4407010454'), '4407010454');
    assert.equal(extractLinkedInJobId('https://www.linkedin.com/jobs/view/intern-swe-4405076690'), '4405076690');
    assert.equal(extractLinkedInJobId('https://www.linkedin.com/jobs/search/?currentJobId=4412315177'), '4412315177');
    assert.equal(extractLinkedInJobId('https://boards.greenhouse.io/x/jobs/123'), null);
  });
});

describe('needsCheck', () => {
  test('polled boards never need a direct check; feeds do after the TTL', () => {
    assert.equal(needsCheck(row({ source: 'Greenhouse' }), now), false);
    assert.equal(needsCheck(row({}), now), true);
    assert.equal(needsCheck(row({ lastCheckedAt: new Date(now - 2 * DAY).toISOString() }), now), false);
    assert.equal(needsCheck(row({ lastCheckedAt: new Date(now - 8 * DAY).toISOString() }), now), true);
  });
});
