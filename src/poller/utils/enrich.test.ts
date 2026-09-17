import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { enrichForStorage } from './enrich';
import type { RawPosting } from '../../lib/types';

const NOW = '2026-06-04T00:00:00.000Z';

const raw = (over: Partial<RawPosting>): RawPosting => ({
  title: 'SWE Intern',
  company: 'Acme',
  locations: [],
  link: 'https://x.com/a',
  source: 'Greenhouse',
  postedAt: NOW,
  ...over,
});

describe('Enrich salary precedence', () => {
  test('Scraper-provided salary is forwarded, not overwritten by description parse', () => {
    const row = enrichForStorage(raw({
      source: 'YC WaaS',
      salary: { text: '$25/hr', min: 25, max: 25, unit: 'hourly' },
      description: 'We manage $200,000-$300,000/yr portfolios.',
    }), NOW);
    assert.equal(row.salaryText, '$25/hr');
    assert.equal(row.salaryUnit, 'hourly');
  });

  test('Row without a stated salary parses one from title and description', () => {
    const row = enrichForStorage(raw({
      title: 'SWE Intern $30/hr', link: 'https://x.com/c', source: 'Greenhouse',
    }), NOW);
    assert.equal(row.salaryUnit, 'hourly');
  });

  test('enrichForStorage forwards an explicit season instead of defaulting from the title', () => {
    const row = enrichForStorage(
      raw({ title: 'Core Developer Intern', company: 'Seven Research', link: 'https://x/1', source: 'SimplifyJobs', season: ['fall-2026'] }),
      '2026-07-05T00:00:00.000Z',
    );
    assert.deepEqual(row.season, ['fall-2026'], 'the off-season Season column must survive ingestion, not fall to the title default');
  });
});
