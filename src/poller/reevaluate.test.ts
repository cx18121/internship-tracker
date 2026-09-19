import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { staleReason } from './reevaluate';
import { archiveReason } from './classify';
import type { StoredInternship } from '../lib/types';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-16T12:00:00Z');
const row = (over: Partial<StoredInternship>): StoredInternship => ({
  id: 'x', title: 'Software Engineer Intern', company: 'Co', location: 'Austin, TX', locations: ['Austin, TX'], link: 'https://x', source: 'Greenhouse',
  postedAt: new Date(now).toISOString(), seenAt: new Date(now).toISOString(), firstSeenAt: new Date(now).toISOString(),
  archived: false, failedCheckCount: 0, normalizedKey: 'co::x', season: ['summer-2027'], ...over,
});

describe('staleReason', () => {
  test('fresh technical US row is kept', () => {
    assert.equal(staleReason(row({}), now), null);
  });
  test('polled-board row unseen for 8 days is gone', () => {
    assert.equal(staleReason(row({ seenAt: new Date(now - 8 * DAY).toISOString() }), now), 'not seen');
  });
  test('aggregator row gets 30 days', () => {
    assert.equal(staleReason(row({ source: 'SimplifyJobs', seenAt: new Date(now - 8 * DAY).toISOString() }), now), null);
    assert.equal(staleReason(row({ source: 'SimplifyJobs', seenAt: new Date(now - 31 * DAY).toISOString() }), now), 'not seen');
  });
  test('expired season is archived even when recently seen', () => {
    assert.equal(staleReason(row({ season: ['summer-2026'] }), now), 'expired season');
  });
  test('non-US location is archived', () => {
    assert.equal(staleReason(row({ location: 'London, United Kingdom', locations: ['London, United Kingdom'] }), now), 'non-US location');
  });
  test('classified non-technical role is archived; unclassified rows are not judged on role', () => {
    const classified = row({ classifiedAt: new Date(now).toISOString(), roleType: 'other', degrees: [], usEligible: 'yes', isInternship: true });
    assert.equal(staleReason(classified, now), 'role other');
    assert.equal(staleReason(row({ roleType: 'other' }), now), null);
  });
});

describe('archiveReason', () => {
  const base = { degrees: [] as [], usEligible: 'yes' as const, isInternship: true };
  test('keeps technical roles', () => {
    for (const roleType of ['swe', 'ml_ai', 'data', 'quant', 'hardware_ee', 'research_science'] as const) {
      assert.equal(archiveReason({ ...base, roleType }), null);
    }
  });
  test('drops non-technical, non-US, and non-internship', () => {
    assert.equal(archiveReason({ ...base, roleType: 'product_pm' }), 'role product_pm');
    assert.equal(archiveReason({ ...base, roleType: 'swe', usEligible: 'no' }), 'outside the US');
    assert.equal(archiveReason({ ...base, roleType: 'swe', isInternship: false }), 'not an internship');
  });
});
