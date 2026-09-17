import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyHardFilters } from './filter';
import type { RawPosting } from '../lib/types';

const posting = (over: Partial<RawPosting>): RawPosting => ({
  title: 'SWE Intern',
  company: 'Acme',
  locations: [],
  link: 'https://example.com/job/1',
  source: 'test',
  postedAt: '2026-06-01T00:00:00.000Z',
  ...over,
});

describe('Filter', () => {
  test('Non-US location (London, UK) → excluded', () => {
    const r = applyHardFilters(posting({ title: 'SWE Intern', locations: ['London, UK'] }));
    assert.equal(r.passed, false);
    assert.equal(r.reason, 'non-us');
  });

  test('US location (New York, NY) → passes', () => {
    const r = applyHardFilters(posting({ title: 'SWE Intern', locations: ['New York, NY'] }));
    assert.equal(r.passed, true);
  });

  test('PhD and research titles pass; the classifier decides degree and role', () => {
    assert.equal(applyHardFilters(posting({ title: 'PhD Intern – Research', locations: ['New York, NY'] })).passed, true);
    assert.equal(applyHardFilters(posting({ title: 'Research Scientist Intern', locations: ['Seattle, WA'] })).passed, true);
    assert.equal(applyHardFilters(posting({ title: 'Platform Intern', locations: ['San Jose, CA'] })).passed, true);
  });

  test('SWE Intern title → passes', () => {
    const r = applyHardFilters(posting({ title: 'SWE Intern', locations: ['New York, NY'] }));
    assert.equal(r.passed, true);
  });

  test('Closed posting (🔒) → excluded', () => {
    const r = applyHardFilters(posting({ title: '🔒 Backend Engineer Intern', locations: ['Remote'] }));
    assert.equal(r.passed, false);
    assert.equal(r.reason, 'closed');
  });

  test('Non-SWE role (Marketing Intern) → excluded', () => {
    const r = applyHardFilters(posting({ title: 'Marketing Intern', locations: ['San Francisco, CA'] }));
    assert.equal(r.passed, false);
    assert.equal(r.reason, 'non-swe');
  });

  test('SWE role (Backend Engineer Intern) → passes', () => {
    const r = applyHardFilters(posting({ title: 'Backend Engineer Intern', locations: ['San Francisco, CA'] }));
    assert.equal(r.passed, true);
  });

  // Country names must be recognized from the world-countries data, not a
  // hand-maintained alias list.
  test('Non-US: "Cambridge, United Kingdom" → excluded', () => {
    const r = applyHardFilters(posting({ locations: ['Cambridge, United Kingdom'] }));
    assert.equal(r.reason, 'non-us');
  });

  test('Non-US: "Hsinchu, Taiwan" → excluded', () => {
    const r = applyHardFilters(posting({ locations: ['Hsinchu, Taiwan'] }));
    assert.equal(r.reason, 'non-us');
  });

  test('Non-US: "Moscow, Russia" → excluded (common name, not "Russian Federation")', () => {
    const r = applyHardFilters(posting({ locations: ['Moscow, Russia'] }));
    assert.equal(r.reason, 'non-us');
  });

  test('Non-US: "Abidjan, Ivory Coast" → excluded (common, not "Côte d\'Ivoire")', () => {
    const r = applyHardFilters(posting({ locations: ['Abidjan, Ivory Coast'] }));
    assert.equal(r.reason, 'non-us');
  });

  test('Non-US: "Edinburgh, Scotland" → excluded (UK sub-national)', () => {
    const r = applyHardFilters(posting({ locations: ['Edinburgh, Scotland'] }));
    assert.equal(r.reason, 'non-us');
  });

  test('US: "Las Cruces, New Mexico" → passes (state name beats "mexico" substring)', () => {
    const r = applyHardFilters(posting({ locations: ['Las Cruces, New Mexico'] }));
    assert.equal(r.passed, true);
  });

  // Position-based disambiguation for codes shared between US states and ISO
  // country codes (DE, IN, CA, ID). US format puts the code last; foreign
  // format puts it first.
  test('Non-US: "DE - Berlin" → excluded (country-first with foreign city)', () => {
    const r = applyHardFilters(posting({ locations: ['DE - Berlin'] }));
    assert.equal(r.reason, 'non-us');
  });

  test('Non-US: "CA-ON-MISSISSAUGA-..." → excluded (hierarchical code chain)', () => {
    const r = applyHardFilters(posting({ locations: ['CA-ON-MISSISSAUGA-P22M01'] }));
    assert.equal(r.reason, 'non-us');
  });

  test('Non-US: "IN-Pune" → excluded (foreign city beats Indiana state code)', () => {
    const r = applyHardFilters(posting({ locations: ['IN-Pune'] }));
    assert.equal(r.reason, 'non-us');
  });

  test('US: "AZ - Chandler" → passes (state-prefix form, no foreign city)', () => {
    const r = applyHardFilters(posting({ locations: ['AZ - Chandler'] }));
    assert.equal(r.passed, true);
  });

  test('US: "CA - San Francisco" → passes (California prefix, US city)', () => {
    const r = applyHardFilters(posting({ locations: ['CA - San Francisco'] }));
    assert.equal(r.passed, true);
  });
});

describe('Season expiry (applyHardFilters)', () => {
  test('applyHardFilters uses the explicit season token for expiry, not just the title', () => {
    const expired = applyHardFilters(posting({ title: 'Software Engineer Intern', locations: ['NYC'], season: ['winter-2024'] }));
    assert.equal(expired.passed, false, 'a past-season token must be dropped even when the title carries no season');
    assert.equal(expired.reason, 'expired-season');
    const live = applyHardFilters(posting({ title: 'Software Engineer Intern', locations: ['NYC'], season: ['fall-2027'] }));
    assert.equal(live.passed, true, 'a future-season token must pass');
  });

  test('applyHardFilters: rejects expired-season SWE roles, keeps far-future ones', () => {
    // Ancient/far-future years keep this independent of when the test runs.
    const expired = applyHardFilters(posting({ title: 'Software Engineer Intern - Summer 2020', locations: ['Remote in USA'] }));
    assert.equal(expired.passed, false);
    assert.equal(expired.reason, 'expired-season');
    const future = applyHardFilters(posting({ title: 'Software Engineer Intern - Summer 2099', locations: ['Remote in USA'] }));
    assert.equal(future.passed, true, 'a far-future SWE intern role must pass');
  });
});
