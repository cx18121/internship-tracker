import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPosting } from './build-row';

const SEED_DEFAULTS = {
  title: 'SWE Intern',
  company: 'Acme',
  link: 'https://example.com/job/1',
  source: 'Greenhouse',
  now: '2026-05-22T10:00:00.000Z',
} as const;

describe('buildPosting', () => {
  test('buildPosting: plain-text description set on posting', () => {
    const row = buildPosting({ ...SEED_DEFAULTS, description: 'We hire Python interns.' });
    assert.equal(row.description, 'We hire Python interns.');
  });

  test('buildPosting: descriptionHtml is stripped before storage', () => {
    const row = buildPosting({
      ...SEED_DEFAULTS,
      descriptionHtml: '<p>We hire <strong>Python</strong> interns.</p>',
    });
    assert.ok(row.description, 'Description should be set');
    assert.ok(!row.description!.includes('<'), `Should not contain HTML tags: ${row.description}`);
    assert.ok(row.description!.includes('Python'), 'Should preserve content text');
  });

  test('buildPosting: descriptionHtml decodes HTML entities', () => {
    const row = buildPosting({
      ...SEED_DEFAULTS,
      descriptionHtml: 'XPENG&nbsp;is a leading smart tech company &amp; provider.',
    });
    assert.ok(!row.description!.includes('&nbsp;'), `&nbsp; should be decoded: ${row.description}`);
    assert.ok(!row.description!.includes('&amp;'), `&amp; should be decoded: ${row.description}`);
  });

  test('buildPosting: descriptionHtml wins over description when both set', () => {
    const row = buildPosting({
      ...SEED_DEFAULTS,
      description: 'plain text version',
      descriptionHtml: '<p>html version</p>',
    });
    assert.ok(row.description?.includes('html'), `descriptionHtml should win: ${row.description}`);
    assert.ok(!row.description?.includes('plain'), 'plain text should be ignored when html present');
  });

  test('buildPosting: empty description collapses to undefined', () => {
    assert.equal(buildPosting({ ...SEED_DEFAULTS, description: '' }).description, undefined);
    assert.equal(buildPosting({ ...SEED_DEFAULTS, description: null }).description, undefined);
    assert.equal(buildPosting({ ...SEED_DEFAULTS }).description, undefined);
  });

  test('buildPosting: whitespace-only description collapses to undefined', () => {
    assert.equal(buildPosting({ ...SEED_DEFAULTS, description: '   \n\t  ' }).description, undefined);
  });

  test('buildPosting: empty descriptionHtml collapses to undefined', () => {
    assert.equal(buildPosting({ ...SEED_DEFAULTS, descriptionHtml: '' }).description, undefined);
    assert.equal(buildPosting({ ...SEED_DEFAULTS, descriptionHtml: '<br><br>' }).description, undefined);
  });

  test('buildPosting: postedAt and location wiring', () => {
    const row = buildPosting({
      ...SEED_DEFAULTS,
      upstreamPostedAt: '2026-04-01T00:00:00.000Z',
      location: 'San Francisco, CA',
    });
    assert.equal(row.postedAt, '2026-04-01T00:00:00.000Z');
    assert.equal(row.location, 'San Francisco, CA');
  });

  test('buildPosting: postedAt falls back to now when upstream is null', () => {
    const row = buildPosting({ ...SEED_DEFAULTS, upstreamPostedAt: null });
    assert.equal(row.postedAt, SEED_DEFAULTS.now);
  });

  // JobSpy reports date_posted as a relative string ("5 days ago") which
  // Postgres rejects for a timestamptz column, aborting the whole batch
  // transaction. postedAt must always be a storable timestamp.
  test('buildPosting: unparseable upstream date falls back to now', () => {
    for (const junk of ['5 days ago', 'Just posted', 'yesterday', '30+ days ago', 'not a date']) {
      const row = buildPosting({ ...SEED_DEFAULTS, upstreamPostedAt: junk });
      assert.equal(
        row.postedAt,
        SEED_DEFAULTS.now,
        `unparseable upstream "${junk}" should fall back to now, got ${row.postedAt}`,
      );
      assert.ok(
        !Number.isNaN(new Date(row.postedAt).getTime()),
        `postedAt must be a parseable timestamp for "${junk}", got ${row.postedAt}`,
      );
    }
  });

  test('buildPosting: valid upstream date is preserved', () => {
    const row = buildPosting({ ...SEED_DEFAULTS, upstreamPostedAt: '2026-04-01T00:00:00.000Z' });
    assert.equal(row.postedAt, '2026-04-01T00:00:00.000Z');
  });
});
