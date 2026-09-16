import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isExpiredSeasonTitle, parseSeason } from './seasons';

describe('Season expiry', () => {
  test('parseSeason: distributes a shared year across an adjacent season run', () => {
    // The year binds to every season in the run, not just the nearest — otherwise
    // "Fall / Winter 2026" looks like winter-2026-only and gets wrongly expired.
    assert.deepEqual(parseSeason('Intern (Fall / Winter 2026)').sort(), ['fall-2026', 'winter-2026']);
    assert.deepEqual(parseSeason('Co-op (Summer/Fall 2026)').sort(), ['fall-2026', 'summer-2026']);
    // Single-season titles are unchanged.
    assert.deepEqual(parseSeason('Intern - Summer 2026'), ['summer-2026']);
    // Separate season-year pairs each keep their own year.
    assert.deepEqual(parseSeason('Fall 2026 / Spring 2027').sort(), ['fall-2026', 'spring-2027']);
  });

  test('isExpiredSeasonTitle: drops past cycles, keeps current + future', () => {
    // Pin "now" to 2026-06-05 (summer-2026 cycle) so the test is deterministic.
    const now = new Date('2026-06-05T00:00:00Z');
    const exp = (t: string) => isExpiredSeasonTitle(t, now);
    assert.equal(exp('SWE Intern - Summer 2023'), true);
    assert.equal(exp('SWE Intern - Summer 2025'), true);
    assert.equal(exp('Intern - Embedded Software Engineer (Fall 2025)'), true);
    assert.equal(exp('Software Engineering Intern - Winter 2026'), true);
    assert.equal(exp('Network Software Intern - Spring 2026'), true);
    // Current + future must survive.
    assert.equal(exp('Software Engineer Intern - Summer 2026'), false, 'current summer cycle');
    assert.equal(exp('Software Engineer Intern - Fall 2026'), false);
    assert.equal(exp('Full Stack Software Engineer Intern - Winter 2027'), false);
    // No season info → resolves to current default cycle → never expired.
    assert.equal(exp('Software Engineer Intern'), false);
    // Multi-season posting survives if ANY token is current/future.
    assert.equal(exp('Co-op - Fall 2025 / Spring 2027'), false);
  });
});
