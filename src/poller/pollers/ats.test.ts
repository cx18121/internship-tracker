import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractInternFacets, workdayBoardUrl } from './ats';

describe('Workday facet extraction', () => {
  test('extractInternFacets pulls "Intern Group" from jobFamilyGroup', () => {
    const response = {
      facets: [
        { facetParameter: 'jobFamilyGroup', values: [
          { id: 'a', descriptor: 'Development Group', count: 10 },
          { id: 'x', descriptor: 'Intern Group', count: 5 },
          { id: 'b', descriptor: 'Sales Group', count: 7 },
        ]},
      ],
    };
    const r = extractInternFacets(response);
    assert.deepEqual(r, { jobFamilyGroup: ['x'] });
  });

  test('extractInternFacets pulls multiple matches from workerSubType', () => {
    const response = {
      facets: [
        { facetParameter: 'workerSubType', values: [
          { id: 'reg', descriptor: 'Regular', count: 30 },
          { id: 'int1', descriptor: 'Intern', count: 1 },
          { id: 'int2', descriptor: 'Intern (Fixed Term)', count: 4 },
        ]},
      ],
    };
    const r = extractInternFacets(response);
    assert.deepEqual(r, { workerSubType: ['int1', 'int2'] });
  });

  test('extractInternFacets matches "Co-op" and "Internship" variants', () => {
    const response = {
      facets: [
        { facetParameter: 'jobFamilyGroup', values: [
          { id: '1', descriptor: 'Co-op Program', count: 3 },
          { id: '2', descriptor: 'Internships', count: 8 },
          { id: '3', descriptor: 'Engineering', count: 50 },
        ]},
      ],
    };
    const r = extractInternFacets(response);
    assert.deepEqual(r, { jobFamilyGroup: ['1', '2'] });
  });

  test('workdayBoardUrl roots jobs-variant links at the board, not the host', () => {
    const url = workdayBoardUrl('capitalone.wd12.myworkdayjobs.com', 'capitalone', 'Capital_One', false);
    assert.equal(url, 'https://capitalone.wd12.myworkdayjobs.com/Capital_One');
    assert.equal(
      `${url}/job/McLean-VA/Data-Analyst-Intern---Summer-2027_R244317-1`,
      'https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Data-Analyst-Intern---Summer-2027_R244317-1',
    );
  });

  test('workdayBoardUrl keeps the /recruiting prefix for site-variant links', () => {
    const url = workdayBoardUrl('wd3.myworkdaysite.com', 'magna', 'Magna', true);
    assert.equal(url, 'https://wd3.myworkdaysite.com/recruiting/magna/Magna');
    assert.equal(
      `${url}/job/Southfield-Michigan-US/Intern---Engineering_R00235414`,
      'https://wd3.myworkdaysite.com/recruiting/magna/Magna/job/Southfield-Michigan-US/Intern---Engineering_R00235414',
    );
  });

  test('extractInternFacets ignores facet parameters outside the allowlist', () => {
    const response = {
      facets: [
        { facetParameter: 'locationMainGroup', values: [
          { id: 'loc', descriptor: 'Intern locations', count: 1 },
        ]},
      ],
    };
    const r = extractInternFacets(response);
    assert.deepEqual(r, {});
  });

  test('extractInternFacets returns {} when no intern facet exists', () => {
    const response = {
      facets: [
        { facetParameter: 'jobFamilyGroup', values: [
          { id: 'a', descriptor: 'Engineering', count: 5 },
          { id: 'b', descriptor: 'Sales', count: 3 },
        ]},
      ],
    };
    const r = extractInternFacets(response);
    assert.deepEqual(r, {});
  });

  test('extractInternFacets handles missing/empty response gracefully', () => {
    assert.deepEqual(extractInternFacets({}), {});
    assert.deepEqual(extractInternFacets({ facets: [] }), {});
    assert.deepEqual(extractInternFacets({ facets: [{ facetParameter: 'jobFamilyGroup' }] }), {});
  });
});
