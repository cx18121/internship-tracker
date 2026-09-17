import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workdayDetailUrl } from './description-fetchers';

describe('workdayDetailUrl', () => {
  test('myworkdayjobs host with locale segment', () => {
    assert.equal(
      workdayDetailUrl('https://nxp.wd3.myworkdayjobs.com/en-US/careers/job/Austin/Data-Science-Intern_R-1'),
      'https://nxp.wd3.myworkdayjobs.com/wday/cxs/nxp/careers/job/Austin/Data-Science-Intern_R-1',
    );
  });
  test('myworkdaysite host under /recruiting', () => {
    assert.equal(
      workdayDetailUrl('https://wd3.myworkdaysite.com/recruiting/brevanhoward/BH_External/job/New-York/Intern_JR1'),
      'https://wd3.myworkdaysite.com/wday/cxs/brevanhoward/BH_External/job/New-York/Intern_JR1',
    );
  });
  test('board landing page without /job/ is not a posting', () => {
    assert.equal(workdayDetailUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'), null);
  });
});
