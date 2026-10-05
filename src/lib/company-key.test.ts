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

test('non-Latin company names retain distinct identities', () => {
  const cnh = companyKey('凯斯纽荷兰(中国)管理有限公司');
  assert.equal(cnh, '凯斯纽荷兰管理有限公司');
  assert.equal(companyKey(cnh), cnh);
  assert.equal(companyKey('サイネオス・ヘルス'), 'サイネオスヘルス');
  assert.notEqual(cnh, companyKey('北京五一视界数字孪生科技股份有限公司'));
  assert.notEqual(cnh, companyKey('サイネオス・ヘルス'));
});

test('accented and combining characters are preserved and canonically stable', () => {
  assert.equal(companyKey('Naïve'), 'naïve');
  assert.equal(companyKey('Félix'), companyKey('Fe\u0301lix'));
  assert.equal(companyKey('Ångström AI'), 'ångström');
  assert.equal(companyKey('कंपनी'), 'कंपनी');
  assert.notEqual(companyKey('Félix'), companyKey('Felix'));
  for (const name of ['J\u030c Industries', 'ǰ Industries', 'e-\u0301']) {
    const key = companyKey(name);
    assert.equal(companyKey(key), key);
    assert.equal(key.normalize('NFC'), key);
  }
  assert.equal(companyKey('J\u030c Industries'), companyKey('ǰ Industries'));
});

test('names without an employer identity remain empty', () => {
  for (const name of ['', ' ', '↳', '!!!', 'Inc.']) assert.equal(companyKey(name), '');
});
