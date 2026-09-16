import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCompany, deriveRoleAndComp, deriveLocation } from './handshake-parse';

describe('Handshake card parser', () => {
  test('deriveCompany prefers logo alt', () => {
    assert.equal(
      deriveCompany('Goalbound', 'Goalbound Software Engineering Internship $25/hr · Internship · Jun 14—Jul 30 Remote 3d ago'),
      'Goalbound'
    );
  });

  test('deriveCompany returns null when no logo (caller falls back / drops)', () => {
    assert.equal(deriveCompany('', 'CGTech Software Engineer (UX) Intern $32/hr · Internship · Jun 23—Aug 27 Irvine, CA New'), null);
  });

  test('deriveRoleAndComp strips company prefix and cuts at pay token', () => {
    const r = deriveRoleAndComp('Goalbound', 'Goalbound Software Engineering Internship $25/hr · Internship · Jun 14—Jul 30 Remote 3d ago');
    assert.equal(r.role, 'Software Engineering Internship');
    assert.equal(r.comp, '$25/hr');
  });

  test('deriveRoleAndComp handles Unpaid token (comp empty)', () => {
    const r = deriveRoleAndComp('A Free Bird Corporation', 'A Free Bird Corporation AI Specialist Unpaid · Internship Remote 2wk ago');
    assert.equal(r.role, 'AI Specialist');
    assert.equal(r.comp, '');
  });

  test('deriveRoleAndComp falls back to cut at " · " when no pay/Unpaid token', () => {
    const r = deriveRoleAndComp('Acme', 'Acme Data Intern · Internship · Jun 1—Aug 1 Remote 1d ago');
    assert.equal(r.role, 'Data Intern');
    assert.equal(r.comp, '');
  });

  test('deriveRoleAndComp chops the tail on a no-pay, no-separator card (uses location)', () => {
    // Card shape "{Company} {Role} {Type} {Location} {time}" with no "$" and
    // no " · " — the role must not swallow "Internship Remote 2wk ago".
    const r = deriveRoleAndComp('Rubbl', 'Rubbl Software Engineering Intern Internship Remote 2wk ago', 'Remote');
    assert.equal(r.role, 'Software Engineering Intern');
    assert.equal(r.comp, '');
  });

  test('deriveRoleAndComp chops tail with a multi-word location', () => {
    const r = deriveRoleAndComp('Novora Mgt.', 'Novora Mgt. AI Software Engineer Intern Internship Austin, TX 5d ago', 'Austin, TX');
    assert.equal(r.role, 'AI Software Engineer Intern');
  });

  test('deriveRoleAndComp does NOT chop a well-formed card even if location passed', () => {
    // A card WITH a pay boundary must be untouched by the fallback cleanup.
    const r = deriveRoleAndComp('Goalbound', 'Goalbound Software Engineering Internship $25/hr · Internship · Jun 14—Jul 30 Remote 3d ago', 'Remote');
    assert.equal(r.role, 'Software Engineering Internship');
    assert.equal(r.comp, '$25/hr');
  });

  test('deriveLocation parses footer, dropping Promoted and time-ago', () => {
    assert.equal(deriveLocation('Promoted∙Melrose, MA∙3wk ago'), 'Melrose, MA');
    assert.equal(deriveLocation('Remote∙3d ago'), 'Remote');
    assert.equal(deriveLocation('Remote or San Jose, CA∙2mo ago'), 'Remote or San Jose, CA');
  });

  test('deriveLocation returns empty string when footer yields nothing usable', () => {
    assert.equal(deriveLocation('5d ago'), '');
  });

  test('deriveRoleAndComp does not strip a mid-word company prefix (word boundary)', () => {
    // logo-alt "Fenix Commerc" is a mid-word prefix of "Fenix Commerce ..." —
    // must NOT slice, or the role would start with a stray "e".
    const r = deriveRoleAndComp('Fenix Commerc', 'Fenix Commerce Software Engineer Intern $20/hr · Internship · Remote 1d ago');
    assert.ok(!r.role.startsWith('e '), `role should not start with a fragment: ${r.role}`);
  });

  test('deriveLocation strips verbose relative-time variants', () => {
    assert.equal(deriveLocation('New York, NY∙3 days ago'), 'New York, NY');
    assert.equal(deriveLocation('Boston, MA∙2 hr ago'), 'Boston, MA');
    assert.equal(deriveLocation('Austin, TX∙1 week ago'), 'Austin, TX');
  });

  test('deriveLocation also splits the U+00B7 middle-dot footer variant', () => {
    // If a card renders "·" (U+00B7) instead of "∙" (U+2219), the footer must
    // still split rather than dumping the whole string as location.
    assert.equal(deriveLocation('Promoted·San Francisco, CA·2 days ago'), 'San Francisco, CA');
  });
});
