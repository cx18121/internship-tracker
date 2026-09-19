import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyKey } from './company-key';

test('companyKey collapses suffixes, legal forms, and glued AI', () => {
  assert.equal(companyKey('DatologyAI'), companyKey('Datology'));
  assert.equal(companyKey('Etched.ai'), companyKey('Etched'));
  assert.equal(companyKey('Persona AI'), companyKey('Persona'));
  assert.equal(companyKey('1X Technologies'), companyKey('1X'));
  assert.equal(companyKey('Bedrock Robotics, Inc.'), 'bedrockrobotics');
  assert.notEqual(companyKey('xAI'), companyKey('X'), 'short stems keep their AI');
  assert.notEqual(companyKey('Snap Finance'), companyKey('Snap'));
});
