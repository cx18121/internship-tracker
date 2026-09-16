import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { smartTrimDescription, HANDSHAKE_PROMO_BANNER_SOURCE } from './description-trim';

describe('smartTrim', () => {
  test('smartTrim: empty input returns empty string', () => {
    assert.equal(smartTrimDescription(''), '');
    assert.equal(smartTrimDescription(null), '');
    assert.equal(smartTrimDescription(undefined), '');
  });

  test('smartTrim: substantive opener passes through (no marketing-opener match)', () => {
    // "Job Details: Job Description: ..." is a section header, not a
    // marketing opener. Should not be skipped.
    const input = 'Job Details: Job Description: The Software simulation team is driving software-first strategy at Intel. We need engineers familiar with Python, C++, and Linux. The role involves debugging, automation, and data analysis.';
    const out = smartTrimDescription(input);
    assert.ok(out.startsWith('Job Details:'), `Expected to start with "Job Details:", got: ${out.slice(0, 60)}`);
  });

  test('smartTrim: marketing-opener + section heading → slices from heading', () => {
    const preamble = 'Who We Are Applied Materials is a global leader in materials engineering solutions used to produce virtually every new chip and advanced display in the world. We design, build and service cutting-edge equipment. We are committed to innovation and excellence at every level. ';
    const role = 'TEAM OVERVIEW: AGS Supplier Engineering Group works with suppliers to validate manufacturing capability. The intern will assist with engineering drawing requirements and NPI team coordination.';
    const out = smartTrimDescription(preamble + role);
    assert.ok(out.startsWith('TEAM OVERVIEW:'), `Expected to start with "TEAM OVERVIEW:", got: ${out.slice(0, 60)}`);
    assert.ok(!out.includes('Applied Materials is a global leader'), 'Marketing preamble should be stripped');
  });

  test('smartTrim: marketing-opener + no section heading → kept as-is', () => {
    // Marketing-opener detected but no role-section heading later → skip is a no-op.
    const input = 'Who We Are Acme Corp is a global leader in widgets. We are passionate about widgets. Our widgets are the best widgets in the widget industry. We hire interns to help us widget.';
    const out = smartTrimDescription(input);
    assert.ok(out.startsWith('Who We Are Acme'), 'Should fall back to original when no section heading found');
  });

  test('smartTrim: marketing-opener with section heading at position 0 → no skip', () => {
    // findRoleSectionStart requires position >= MIN_SECTION_POS (200) so
    // a heading at the very start doesn't trigger a meaningless slice.
    const input = 'About the Role: We are hiring an SWE intern. ' + 'The team builds infrastructure. '.repeat(10);
    const out = smartTrimDescription(input);
    assert.ok(out.startsWith('About the Role:'), 'Should preserve a section heading already at the start');
  });

  test('smartTrim: end-marker trim drops EEO tail', () => {
    const role = 'About the Role: We are seeking a software engineer intern. ' + 'You will write code, review code, and deploy code. '.repeat(8);
    const tail = ' Equal Opportunity Employer: All qualified applicants will receive consideration without regard to race, color, religion, sex, national origin, sexual orientation, gender identity, age, disability, or any other characteristic protected by law.';
    const out = smartTrimDescription(role + tail);
    assert.ok(!out.includes('Equal Opportunity'), `EEO tail should be trimmed, got tail: ${out.slice(-100)}`);
    assert.ok(out.includes('software engineer intern'), 'Real role content should survive');
  });

  test('smartTrim: end-marker drops ALL-CAPS WHAT WE OFFER tail (but not title-case)', () => {
    // ALL-CAPS "WHAT WE OFFER" is an unambiguous section divider. Title-case
    // "What We Offer" fires too often mid-content.
    const role = 'Job Description: Build software. We need Python developers. '.repeat(8);
    const allcaps = ' WHAT WE OFFER: Competitive salary, benefits, and culture.';
    const titlecase = ' What We Offer: ' + 'fun engineering work and deep tech challenges. '.repeat(8);

    const outAllcaps = smartTrimDescription(role + allcaps);
    assert.ok(!outAllcaps.includes('WHAT WE OFFER'), 'ALL-CAPS WHAT WE OFFER should be trimmed');

    const outTitle = smartTrimDescription(role + titlecase);
    assert.ok(outTitle.includes('What We Offer'), 'Title-case "What We Offer" should NOT trigger end-trim');
  });

  test('smartTrim: case-insensitive section heading matches lowercase', () => {
    // Section-heading list is canonically Title-Case, but the regex uses /i.
    const preamble = 'Who We Are MyCompany is a leading provider of widgets. We are committed to excellence. '.repeat(8);
    const role = ' about the role: We are looking for an intern who can debug Python code.';
    const out = smartTrimDescription(preamble + role);
    assert.ok(/about the role/i.test(out.slice(0, 50)), `Lowercase heading should match. Got head: ${out.slice(0, 100)}`);
  });

  test('smartTrim: cap at maxLen prefers sentence boundary', () => {
    const sentences = 'This is sentence one. This is sentence two. This is sentence three. '.repeat(50);
    const out = smartTrimDescription(sentences, 200);
    assert.ok(out.length <= 200, `Should respect cap, got length ${out.length}`);
    // Should end at a sentence boundary, not mid-word
    assert.ok(/[.!?]$/.test(out), `Expected sentence-end punctuation, got tail: "${out.slice(-30)}"`);
  });

  test('smartTrim: cap hard-cuts when no sentence boundary within window', () => {
    // No periods within the cap window → falls back to hard slice.
    const noBoundary = 'word '.repeat(500);
    const out = smartTrimDescription(noBoundary, 100);
    assert.ok(out.length <= 100, `Should respect cap, got length ${out.length}`);
  });

  test('smartTrim: idempotent — running twice yields same output', () => {
    const samples = [
      '',
      'Who We Are Acme is a leader in widgets. TEAM OVERVIEW: The team builds widgets. ' + 'You will widget. '.repeat(30),
      'Job Description: Build software. Python required. ' + 'Day-to-day: code review. '.repeat(20),
    ];
    for (const s of samples) {
      const once = smartTrimDescription(s);
      const twice = smartTrimDescription(once);
      assert.equal(twice, once, `smartTrim should be idempotent on: "${s.slice(0, 40)}..."`);
    }
  });

  test('HANDSHAKE_PROMO_BANNER_SOURCE: RegExp built from source matches exact banner', () => {
    const re = new RegExp(HANDSHAKE_PROMO_BANNER_SOURCE, 'gi');
    const banner = "Describe your goals, preferences, or background, and we'll find the best jobs tailored to you. Everything the website does for on-the-go career support. Plus reminders so you never miss a thing.";
    assert.ok(re.test(banner), 'Banner regex should match the exact stable wording');
  });

  test('HANDSHAKE_PROMO_BANNER_SOURCE: handles variable whitespace between sentences', () => {
    // Build a fresh RegExp per variant — global flag's lastIndex is stateful.
    const variants = [
      "Describe your goals, preferences, or background, and we'll find the best jobs tailored to you.  Everything the website does for on-the-go career support.\nPlus reminders so you never miss a thing.",
      "Describe your goals, preferences, or background, and we'll find the best jobs tailored to you.\n\nEverything the website does for on-the-go career support.\n\nPlus reminders so you never miss a thing",
    ];
    for (const v of variants) {
      assert.ok(new RegExp(HANDSHAKE_PROMO_BANNER_SOURCE, 'gi').test(v), `Should match variant: ${v.slice(0, 40)}...`);
    }
  });
});
