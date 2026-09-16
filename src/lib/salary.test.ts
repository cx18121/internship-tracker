import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalary } from './salary';

describe('Salary parser', () => {
  test('Unpaid role yields no salary even if description has a $ figure', () => {
    const s = parseSalary('Full Stack Engineering Internship Unpaid. Our platform manages $120,000-$180,000 in assets.');
    assert.equal(s.text, null);
    assert.equal(s.unit, null);
  });

  test('Bare unit-less $ range is not treated as salary', () => {
    const s = parseSalary('Software Engineer Intern. We raised $50,000-$75,000 in our seed round.');
    assert.equal(s.text, null);
  });

  test('Anchored hourly range parses', () => {
    const s = parseSalary('SWE Intern $25-30/hr');
    assert.equal(s.unit, 'hourly');
    assert.equal(s.min, 25);
    assert.equal(s.max, 30);
  });

  test('Anchored k-suffix yearly range parses', () => {
    const s = parseSalary('New Grad $120-180k');
    assert.equal(s.unit, 'yearly');
    assert.equal(s.min, 120000);
    assert.equal(s.max, 180000);
  });
});
