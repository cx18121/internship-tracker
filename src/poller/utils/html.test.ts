import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml } from './html';

describe('HTML decode', () => {
  test('stripHtml decodes entities in a Greenhouse-style title', () => {
    assert.equal(stripHtml('Data Science Intern &#8211; Summer 2026 &amp; Beyond'), 'Data Science Intern – Summer 2026 & Beyond');
  });
});
