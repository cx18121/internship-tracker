import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickListFields, LIST_FIELDS } from './list-item';
import type { Internship } from '@/lib/types';

describe('pickListFields', () => {
  test('pickListFields keeps UI/consumer fields and drops heavy unused ones', () => {
    const full: Internship = {
      id: 'x1', title: 'SWE Intern', company: 'Acme', location: 'NYC', locations: ['NYC'], metros: ['nyc'],
      link: 'https://a.co/x1', source: 'Greenhouse', postedAt: '2026-01-01',
      seenAt: '2026-01-02', firstSeenAt: '2026-01-02', score: 88, scoreLabel: 'A',
      matchedKeywords: ['backend'],
      archived: false, failedCheckCount: 0, normalizedKey: 'acme::swe',
      salaryText: '$50/hr', season: ['summer-2026'],
      // fields that must NOT ship to the list view:
      description: 'x'.repeat(5000), salaryMin: 50, salaryMax: 60,
      salaryUnit: 'hourly',
    };
    const out = pickListFields(full);
    // Required by the list/card UI.
    for (const f of ['id', 'title', 'company', 'link', 'source', 'score',
                     'scoreLabel', 'postedAt', 'seenAt', 'location',
                     'salaryText', 'season']) {
      assert.ok(f in out, `expected field ${f} to be kept`);
    }
    // Heavy / unused — must be dropped.
    for (const f of ['description', 'salaryMin', 'salaryMax', 'salaryUnit', 'matchedKeywords']) {
      assert.ok(!(f in out), `expected field ${f} to be dropped`);
    }
    // The allowlist and the output keys agree.
    assert.deepEqual(Object.keys(out).sort(), [...LIST_FIELDS].sort());
  });
});
