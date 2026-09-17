import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { metroFor, metrosFor } from './metros';

describe('metroFor', () => {
  test('aliases and Workday-style strings land in the right metro', () => {
    const cases: Array<[string, string]> = [
      ['SF', 'bay'], ['San Francisco, CA', 'bay'], ['US, CA, Santa Clara', 'bay'], ['South SF', 'bay'], ['Palo Alto, CA, US', 'bay'],
      ['NYC', 'nyc'], ['New York, NY', 'nyc'], ['New York', 'nyc'], ['Brooklyn, NY', 'nyc'],
      ['Seattle, WA', 'seattle'], ['Redmond, WA', 'seattle'],
      ['Boston, MA', 'boston'], ['Cambridge, MA', 'boston'],
      ['Los Angeles, CA', 'la'], ['El Segundo, CA', 'la'],
      ['Chicago, IL', 'chicago'], ['Austin, TX', 'austin'],
      ['Remote', 'remote'], ['Remote in USA', 'remote'], ['Remote, US', 'remote'],
      ['Pittsburgh, PA', 'other'], ['United States', 'other'], ['', 'other'],
    ];
    for (const [loc, metro] of cases) assert.equal(metroFor(loc), metro, loc);
  });

  test('a city named first wins over a remote tag', () => {
    assert.equal(metroFor('Seattle, WA (Remote OK)'), 'seattle');
  });

  test('word boundaries: "sf" does not fire inside other words, Cambridge needs MA', () => {
    assert.equal(metroFor('Transfer Intern Site'), 'other');
    assert.equal(metroFor('Cambridge, United Kingdom'), 'other');
  });
});

describe('metrosFor', () => {
  test('one metro per distinct location, in canonical order', () => {
    assert.deepEqual(metrosFor(['Seattle, WA', 'SF', 'New York, NY', 'Sunnyvale, CA']), ['bay', 'nyc', 'seattle']);
    assert.deepEqual(metrosFor([]), []);
  });
});
