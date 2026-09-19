import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { jobKey, discoverATSTarget } from './index';
import { workdayDetailUrl } from './workday';

describe('jobKey', () => {
  test('the same ATS job is one key regardless of slug case, embed flags, or application suffix', () => {
    const a = jobKey('https://jobs.ashbyhq.com/DatologyAI/0ced19c2-21ec-4bcc-92d2-68d448279f3f/application?embed=true');
    const b = jobKey('https://jobs.ashbyhq.com/datologyai/0ced19c2-21ec-4bcc-92d2-68d448279f3f');
    assert.equal(a, b);
    assert.equal(a, 'ashby:0ced19c2-21ec-4bcc-92d2-68d448279f3f');
    assert.equal(jobKey('https://boards.greenhouse.io/stripe/jobs/123?gh_src=x'), jobKey('https://job-boards.greenhouse.io/Stripe/jobs/123'));
    assert.equal(jobKey('https://stripe.com/jobs/apply?gh_jid=123'), 'greenhouse:123');
    assert.equal(jobKey('https://boards.greenhouse.io/embed/job_app?token=243853'), 'greenhouse:243853');
    assert.equal(jobKey('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Intern_JR1998421'), 'workday:jr1998421');
    assert.equal(jobKey('https://www.linkedin.com/jobs/view/software-engineer-intern-at-x-4300000001?refId=1'), 'linkedin:4300000001');
    assert.equal(jobKey('https://www.linkedin.com/jobs/search/?currentJobId=4253822234'), 'linkedin:4253822234');
    assert.equal(jobKey('https://jobs.lever.co/x/11111111-1111-1111-1111-111111111111/apply'), 'lever:11111111-1111-1111-1111-111111111111');
  });

  test('unknown hosts keep the query string because it may hold the job id', () => {
    assert.equal(jobKey('https://Example.com/careers/42/#top'), 'https://example.com/careers/42');
    assert.notEqual(jobKey('https://x.taleo.net/careersection/x/jobdetail.ftl?job=1'), jobKey('https://x.taleo.net/careersection/x/jobdetail.ftl?job=2'));
  });

  test('a board landing page has no job id and falls back to the URL', () => {
    assert.equal(jobKey('https://jobs.lever.co/acme'), 'https://jobs.lever.co/acme');
    assert.equal(jobKey('https://www.linkedin.com/jobs/search/'), 'https://www.linkedin.com/jobs/search');
  });
});

describe('discoverATSTarget', () => {
  test('reads the board slug from a posting link on each ATS', () => {
    assert.deepEqual(discoverATSTarget('https://boards.greenhouse.io/acme/jobs/1', 'Acme'), { slug: 'acme', ats: 'greenhouse', name: 'Acme' });
    assert.deepEqual(discoverATSTarget('https://jobs.ashbyhq.com/Acme/uuid', 'Acme'), { slug: 'Acme', ats: 'ashby', name: 'Acme' });
    assert.deepEqual(discoverATSTarget('https://ats.rippling.com/en-US/acme/jobs/uuid', 'Acme'), { slug: 'acme', ats: 'rippling', name: 'Acme' });
    assert.deepEqual(discoverATSTarget('https://acme.wd5.myworkdayjobs.com/en-US/External/job/x/y_R1', 'Acme'),
      { slug: 'acme', ats: 'workday', board: 'External', wdInstance: 'wd5', name: 'Acme' });
    assert.equal(discoverATSTarget('https://boards.greenhouse.io/embed/job_app?token=1', 'Acme'), null);
    assert.equal(discoverATSTarget('https://acme.com/careers', 'Acme'), null);
  });
});

describe('workdayDetailUrl', () => {
  test('both host variants map to the CXS detail endpoint; landing pages do not', () => {
    assert.equal(
      workdayDetailUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Intern_JR1'),
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Intern_JR1',
    );
    assert.equal(
      workdayDetailUrl('https://wd1.myworkdaysite.com/recruiting/acme/External/job/Boston/Intern_R2'),
      'https://wd1.myworkdaysite.com/wday/cxs/acme/External/job/Boston/Intern_R2',
    );
    assert.equal(workdayDetailUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'), null);
  });
});
