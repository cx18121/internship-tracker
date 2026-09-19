import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { jobKey } from './job-key';

describe('jobKey', () => {
  test('the same ATS job is one key regardless of slug case, embed flags, or application suffix', () => {
    const a = jobKey('https://jobs.ashbyhq.com/DatologyAI/0ced19c2-21ec-4bcc-92d2-68d448279f3f/application?embed=true');
    const b = jobKey('https://jobs.ashbyhq.com/datologyai/0ced19c2-21ec-4bcc-92d2-68d448279f3f');
    assert.equal(a, b);
    assert.equal(a, 'ashby:0ced19c2-21ec-4bcc-92d2-68d448279f3f');
    assert.equal(jobKey('https://boards.greenhouse.io/stripe/jobs/123?gh_src=x'), jobKey('https://job-boards.greenhouse.io/Stripe/jobs/123'));
    assert.equal(jobKey('https://stripe.com/jobs/apply?gh_jid=123'), 'greenhouse:123');
    assert.equal(jobKey('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Intern_JR1998421'), 'workday:jr1998421');
    assert.equal(jobKey('https://www.linkedin.com/jobs/view/software-engineer-intern-at-x-4300000001?refId=1'), 'linkedin:4300000001');
  });

  test('unknown hosts keep the query string because it may hold the job id', () => {
    assert.equal(jobKey('https://Example.com/careers/42/#top'), 'https://example.com/careers/42');
    assert.notEqual(jobKey('https://x.taleo.net/careersection/x/jobdetail.ftl?job=1'), jobKey('https://x.taleo.net/careersection/x/jobdetail.ftl?job=2'));
    assert.notEqual(jobKey('https://www.linkedin.com/jobs/search/?currentJobId=1'), jobKey('https://www.linkedin.com/jobs/search/?currentJobId=2'));
    assert.equal(jobKey('https://www.linkedin.com/jobs/search/?currentJobId=4253822234'), 'linkedin:4253822234');
    assert.equal(jobKey('https://boards.greenhouse.io/embed/job_app?token=243853'), 'greenhouse:243853');
  });

  test('different jobs on the same board stay distinct', () => {
    assert.notEqual(jobKey('https://jobs.lever.co/x/11111111-1111-1111-1111-111111111111'), jobKey('https://jobs.lever.co/x/22222222-2222-2222-2222-222222222222'));
  });
});
