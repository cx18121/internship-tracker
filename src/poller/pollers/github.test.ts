import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows } from './github';

describe('SimplifyJobs row parser', () => {
  test('parseRows: extracts a row and prefers the direct ATS link over the simplify fallback', () => {
    // Mirrors the 5-column README.md layout: the Apply cell holds the direct ATS
    // link first, then a simplify.jobs fallback. parseRows must pick the direct
    // link so the ATS adapter (here Rippling) can discover + poll the board.
    const html = `
<tr>
<td><strong><a href="https://rippling.com">Rippling</a></strong></td>
<td>Software Engineer Intern - Backend Focused - Winter 2027</td>
<td>New York, NY</td>
<td><div align="center"><a href="https://ats.rippling.com/rippling/jobs/35b3ba25-ff2e-4b68-a2d7-61be26f2b24a?utm_source=Simplify&ref=Simplify"><img src="x.png" width="50" alt="Apply"></a> <a href="https://simplify.jobs/p/0d8819e9?utm_source=GHList"><img src="y.png" width="26" alt="Simplify"></a></div></td>
<td>0d</td>
</tr>`;
    const rows = parseRows(html);
    assert.equal(rows.length, 1, 'should parse exactly one row');
    assert.equal(rows[0].company, 'Rippling');
    assert.equal(rows[0].title, 'Software Engineer Intern - Backend Focused - Winter 2027');
    assert.equal(rows[0].location, 'New York, NY');
    assert.ok(
      rows[0].link.startsWith('https://ats.rippling.com/rippling/jobs/35b3ba25'),
      `expected the direct ATS link, got ${rows[0].link}`,
    );
  });

  test('parseRows: off-season 6-column layout puts Application after the Season column', () => {
    // README-Off-Season.md inserts a Season column that README.md lacks:
    // Company | Role | Location | Season | Application | Age. A parser hardcoding
    // cell 3 reads the season text and returns a blank apply link.
    const html = `
<tr>
<td><strong><a href="https://simplify.jobs/c/Seven-Research?utm_source=GHList&utm_medium=company">Seven Research</a></strong></td>
<td>Core Developer Intern</td>
<td>NYC</td>
<td>Fall 2026</td>
<td><div align="center"><a href="https://job-boards.greenhouse.io/sevenresearch/jobs/4895047008?utm_source=Simplify&ref=Simplify"><img src="x.png" width="50" alt="Apply"></a> <a href="https://simplify.jobs/p/abc?utm_source=GHList"><img src="y.png" width="26" alt="Simplify"></a></div></td>
<td>3d</td>
</tr>`;
    const rows = parseRows(html);
    assert.equal(rows.length, 1, 'should parse exactly one row');
    assert.equal(rows[0].location, 'NYC', 'location must not absorb the season column');
    assert.equal(rows[0].season, 'Fall 2026', 'must capture the season column so the row is not mis-defaulted');
    assert.ok(
      rows[0].link.startsWith('https://job-boards.greenhouse.io/sevenresearch/jobs/4895047008'),
      `expected the apply link from the second-to-last cell, got "${rows[0].link}"`,
    );
  });

  test('parseRows: skips the header row and multi-location continuation (↳) rows', () => {
    const html = `
<tr><td>Company</td><td>Role</td><td>Location</td><td>Application</td></tr>
<tr><td><strong><a href="https://x">↳</a></strong></td><td>Extra Loc Intern</td><td>Austin, TX</td><td><a href="https://boards.greenhouse.io/acme/jobs/1">Apply</a></td></tr>`;
    assert.equal(parseRows(html).length, 0, 'header + ↳ continuation rows must be dropped');
  });
});
