import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripUtm, stripEmojiPrefix } from './normalize';

// Apply links are shown to the user verbatim from the stored `link`, so
// aggregator tracking params must go. Params that ARE the job identifier
// (Indeed `jk=`, Greenhouse `gh_jid=`) must survive or dedup breaks.
describe('stripUtm', () => {
  test('stripUtm: Simplify utm_source+ref removed', () =>
    assert.equal(
      stripUtm('https://job-boards.greenhouse.io/planetlabs/jobs/7774031?utm_source=Simplify&ref=Simplify'),
      'https://job-boards.greenhouse.io/planetlabs/jobs/7774031'));
  test('stripUtm: gh_src source token removed', () =>
    assert.equal(
      stripUtm('https://cellinktechnologies.com/job-listing?gh_jid=4691297005&gh_src=Simplify'),
      'https://cellinktechnologies.com/job-listing?gh_jid=4691297005'));
  // Exact-equality (not .includes) so a tracking param leaking through ALONGSIDE
  // the kept job id would still fail the test.
  test('stripUtm: gh_jid job id KEPT, surrounding tracking stripped', () =>
    assert.equal(
      stripUtm('https://www.brex.com/careers/8434389002?gh_jid=8434389002&utm_source=Simplify&ref=Simplify'),
      'https://www.brex.com/careers/8434389002?gh_jid=8434389002'));
  test('stripUtm: Indeed jk job id KEPT, surrounding tracking stripped', () =>
    assert.equal(
      stripUtm('https://www.indeed.com/viewjob?jk=5672f4d7e4739c43&utm_source=Simplify'),
      'https://www.indeed.com/viewjob?jk=5672f4d7e4739c43'));
  test('stripUtm: functional params (mobile/needsRedirect) survive, tracking stripped', () =>
    assert.equal(
      stripUtm('https://careers-cotiviti.icims.com/jobs/18817/job?mobile=true&needsRedirect=false&utm_source=Simplify&ref=Simplify'),
      'https://careers-cotiviti.icims.com/jobs/18817/job?mobile=true&needsRedirect=false'));
  test('stripUtm: clean link unchanged', () =>
    assert.equal(
      stripUtm('https://jobs.lever.co/ivo/83b626de-53c8-4505-b0ea-253fdcb83680/apply'),
      'https://jobs.lever.co/ivo/83b626de-53c8-4505-b0ea-253fdcb83680/apply'));
  test('stripUtm: empty string passes through', () => assert.equal(stripUtm(''), ''));
});

describe('SimplifyJobs title emoji', () => {
  test('Emoji badges are stripped from SimplifyJobs titles', () => {
    assert.equal(stripEmojiPrefix('Research Intern - SDN Traffic Intelligence & Control 🎓').trim(), 'Research Intern - SDN Traffic Intelligence & Control');
    assert.equal(stripEmojiPrefix('Software Engineer Intern 🛂🇺🇸').trim(), 'Software Engineer Intern');
  });
});
