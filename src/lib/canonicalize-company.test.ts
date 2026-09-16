import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeCompany } from './canonicalize-company';

// The cross-source dedup key and by-company grouping both key off this
// output. "NVIDIA" and "NVIDIA AI" must collapse to one company WITHOUT
// merging genuinely distinct companies that share a token.
describe('canonicalizeCompany', () => {
  const canonEq = (input: string, expected: string) =>
    assert.equal(canonicalizeCompany(input), expected);

  test('canonicalize: strips ", Inc."', () => canonEq('Itron, Inc.', 'Itron'));
  test('canonicalize: strips " Inc" bare', () => canonEq('Synopsys Inc', 'Synopsys'));
  test('canonicalize: strips ", LLC"', () => canonEq('Persistent Systems, LLC', 'Persistent Systems'));
  test('canonicalize: strips " Corporation"', () => canonEq('Fortera Corporation', 'Fortera'));
  test('canonicalize: strips " Company"', () => canonEq('Base Power Company', 'Base Power'));
  test('canonicalize: strips chained "Company, Inc."', () => canonEq('Al Warren Oil Company, Inc.', 'Al Warren Oil'));
  test('canonicalize: strips ", N.A."', () => canonEq('The Bancorp Bank, N.A.', 'The Bancorp Bank'));
  test('canonicalize: strips trailing (SRA) tag', () => canonEq('Samsung Research America (SRA)', 'Samsung Research America'));
  test('canonicalize: alias NVIDIA AI -> NVIDIA', () => canonEq('NVIDIA AI', 'NVIDIA'));
  test('canonicalize: alias Perplexity AI -> Perplexity', () => canonEq('Perplexity AI', 'Perplexity'));
  test('canonicalize: alias Adobe Systems -> Adobe', () => canonEq('Adobe Systems', 'Adobe'));
  test('canonicalize: alias Amazon.com -> Amazon', () => canonEq('Amazon.com', 'Amazon'));
  test('canonicalize: alias CACI International -> CACI', () => canonEq('CACI International', 'CACI'));
  test('canonicalize: idempotent on alias output', () => canonEq(canonicalizeCompany('NVIDIA AI'), 'NVIDIA'));
  test('canonicalize: idempotent on suffix output', () => canonEq(canonicalizeCompany('TikTok Inc.'), 'TikTok'));
  test('canonicalize: Character AI NOT merged to Character', () => canonEq('Character AI', 'Character AI'));
  test('canonicalize: Palo Alto Networks keeps Networks', () => canonEq('Palo Alto Networks', 'Palo Alto Networks'));
  test('canonicalize: Costco not stripped (Co substring)', () => canonEq('Costco', 'Costco'));
  test('canonicalize: Smiths Detection not stripped to Smith', () => canonEq('Smiths Detection', 'Smiths Detection'));
  test('canonicalize: empty stays empty', () => canonEq('', ''));
  test('canonicalize: whitespace trimmed', () => canonEq('  NVIDIA  ', 'NVIDIA'));
});
