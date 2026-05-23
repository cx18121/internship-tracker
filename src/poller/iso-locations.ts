// Location classifier for the non-US filter.
//
// Strategy: split the location on commas/dashes/pipes, trim each part,
// then:
//   1. positive US check — if any part is a US state code, US state name,
//      or US country indicator, return 'us'
//   2. negative US check — if any part exactly matches a non-US ISO code
//      or country name, return 'non_us'
//   3. substring fallback — if the full location contains a non-US country
//      name or a known foreign city, return 'non_us'
//   4. otherwise — return 'unknown' (caller treats unknown as passing)
//
// The parts-based positive US check runs first, so "Las Cruces, New Mexico"
// returns 'us' before substring fallback ever sees "mexico". Same for
// "Paris, KY" (matches "ky"), "Vienna, VA, US" (matches "va" and "us"),
// and "Cambridge, MA, US" (matches "ma" and "us"). Country coverage comes
// from world-countries (common + official + altSpellings + cca2 + cca3),
// so colloquial forms like "United Kingdom", "Russia", and "Ivory Coast"
// match without a hand-maintained alias table.

import countries from 'world-countries';

export type LocationClassification = 'us' | 'non_us' | 'unknown';

const US_COUNTRY_INDICATORS = new Set<string>([
  'us', 'usa', 'u.s.', 'u.s.a.',
  'united states', 'united states of america',
]);

const US_STATE_CODES = new Set<string>([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
  'dc', 'pr', 'gu', 'vi', 'as', 'mp',
]);

const US_STATE_NAMES = new Set<string>([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
  'puerto rico', 'guam',
]);

// Country data is sourced from `world-countries`, which ships three name
// fields per country (common / official / altSpellings) instead of the
// single formal name `iso-3166-1` exposes. The colloquial form humans
// type into job postings ("United Kingdom", "Russia", "South Korea",
// "Ivory Coast") is the `common` name; alt spellings carry historical
// and variant forms ("Burma" for Myanmar, "Holy See" for Vatican City,
// "Great Britain" for the UK). Pulling all three eliminates the
// hand-maintained alias list this module used to carry.
function canonicalize(s: string): string {
  return s
    .replace(/\s*\([^)]*\)/g, '') // strip parentheticals like "Taiwan (Province of China)"
    .trim()
    .toLowerCase();
}

const NON_US_COUNTRY_CODES = new Set<string>();
const NON_US_COUNTRY_NAMES = new Set<string>();
for (const c of countries) {
  if (c.cca2 === 'US') continue;
  NON_US_COUNTRY_CODES.add(c.cca2.toLowerCase());
  NON_US_COUNTRY_CODES.add(c.cca3.toLowerCase());
  NON_US_COUNTRY_NAMES.add(canonicalize(c.name.common));
  NON_US_COUNTRY_NAMES.add(canonicalize(c.name.official));
  for (const alt of c.altSpellings ?? []) {
    const norm = canonicalize(alt);
    if (norm) NON_US_COUNTRY_NAMES.add(norm);
  }
}

// England, Scotland, Wales, and Northern Ireland are sub-national parts of
// the UK and don't have their own ISO 3166-1 entries, but they're how
// people commonly write UK locations ("Edinburgh, Scotland"). Add manually.
for (const part of ['england', 'scotland', 'wales', 'northern ireland']) {
  NON_US_COUNTRY_NAMES.add(part);
}

// Known unambiguous US cities/abbreviations — symmetric to NON_US_CITY_HINTS
// on the positive side. Without this, bare strings like "NYC" or "Working
// in San Francisco" fall through to 'unknown' because there's no state
// code or country indicator to latch onto. Only includes names with no
// significant foreign collision in job-posting contexts — skipped: san
// jose (CR), portland (multiple), washington (DC/state/many), cambridge
// (UK), manchester (UK), birmingham (UK/AL), bay area (HK collision).
const US_CITY_HINTS = new Set<string>([
  // Short abbreviations — caught only by parts/tokens exact match (substring
  // path skips length < 5 to avoid false positives inside longer words).
  'nyc', 'dmv',
  // Single-word cities
  'chicago', 'boston', 'seattle', 'philadelphia', 'philly',
  'houston', 'dallas', 'austin', 'atlanta', 'denver',
  'minneapolis', 'pittsburgh', 'detroit', 'phoenix',
  'nashville', 'charlotte', 'baltimore', 'orlando', 'tampa',
  'raleigh', 'cleveland', 'cincinnati', 'indianapolis',
  'albuquerque', 'brooklyn', 'manhattan', 'harlem', 'bronx', 'queens',
  // Multi-word — caught via parts exact match for "City, State" form and
  // substring fallback for embedded form ("Working in San Francisco").
  'new york city',
  'san francisco', 'silicon valley',
  'los angeles',
  'san diego',
  'jersey city',
  'kansas city',
  'st louis', 'st. louis', 'saint louis',
  'new orleans',
  'salt lake city',
  'las vegas',
  'long island',
]);

// Known non-US cities that show up unstructured (no comma, no country
// suffix) — the parts-based check has no country part to inspect. These
// only fire from the substring fallback, after the positive US check has
// already passed structured "City, US-State" locations through.
const NON_US_CITY_HINTS = new Set<string>([
  'bangalore', 'bengaluru', 'hyderabad', 'mumbai', 'pune', 'chennai', 'noida',
  'tokyo', 'osaka', 'seoul', 'taipei', 'shanghai', 'beijing', 'shenzhen',
  'hong kong', 'singapore', 'sydney', 'melbourne', 'auckland',
  'london', 'manchester', 'edinburgh', 'dublin',
  'paris', 'lyon', 'berlin', 'munich', 'frankfurt', 'hamburg',
  'amsterdam', 'rotterdam', 'brussels', 'zurich', 'geneva', 'vienna',
  'stockholm', 'oslo', 'copenhagen', 'helsinki',
  'madrid', 'barcelona', 'lisbon', 'rome', 'milan', 'milano',
  'warsaw', 'warszawa', 'krakow', 'kraków', 'gdansk', 'wrocław', 'wroclaw',
  'prague', 'budapest', 'bucharest', 'athens',
  'istanbul', 'tel aviv', 'dubai', 'abu dhabi', 'cairo',
  'jakarta', 'manila', 'bangkok', 'kuala lumpur', 'ho chi minh',
  'toronto', 'montreal', 'vancouver', 'ottawa', 'calgary', 'edmonton',
  'mexico city', 'guadalajara', 'monterrey',
  'sao paulo', 'são paulo', 'rio de janeiro', 'buenos aires', 'bogota',
  'santiago', 'lima',
]);

function splitParts(location: string): string[] {
  // Comma, slash, dash, pipe, middle-dot are all real separators we see in
  // scraped location strings ("Dublin, OH / Hybrid", "City - Region", etc).
  return location
    .split(/[,\-|·/]/u)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

function tokenize(parts: string[]): string[] {
  // Split each part further on whitespace. Catches space-separated trailing
  // country indicators like "Cambridge, MA USA" where the part "ma usa"
  // wouldn't match US_COUNTRY_INDICATORS on its own but the "usa" token does.
  return parts.flatMap((p) => p.split(/\s+/).filter(Boolean));
}

export function classifyLocation(location: string): LocationClassification {
  const trimmed = (location || '').trim().toLowerCase();
  if (!trimmed) return 'unknown';

  const parts = splitParts(trimmed);
  const tokens = tokenize(parts);
  const lastPart = parts[parts.length - 1];

  // (A) Strong US: full state name or unambiguous country indicator. These
  // never collide with non-US country names/codes, so accept unconditionally.
  // Runs first so "Las Cruces, New Mexico" returns 'us' before any "mexico"
  // substring check fires.
  for (const part of parts) {
    if (US_COUNTRY_INDICATORS.has(part)) return 'us';
    if (US_STATE_NAMES.has(part)) return 'us';
  }
  for (const token of tokens) {
    if (US_COUNTRY_INDICATORS.has(token)) return 'us';
    // State-name tokens too — catches "Austin, Texas Metropolitan Area"
    // (part "texas metropolitan area" doesn't match, but token "texas"
    // does). Safe because full state names are multi-char, no English
    // word collisions.
    if (US_STATE_NAMES.has(token)) return 'us';
  }
  // Multi-word "united states" inside a single part — catches
  // "San Mateo, CA United States" where the part "ca united states"
  // isn't a token match for either "united" or "states" alone.
  if (/\bunited states\b/.test(trimmed)) return 'us';

  // (B) Ambiguity break for 3+ parts: many US state codes collide with ISO
  // country codes (DE = Delaware/Germany, IN = Indiana/India, GA = Georgia/
  // Georgia, etc). When a location has 3+ parts and the last part is a
  // non-US country code, prefer the "city, region, country" reading
  // ("Reutlingen, BW, de" → Germany). 2-part "City, ST" form keeps the
  // state interpretation in step C below ("Wilmington, DE" → Delaware).
  if (parts.length >= 3 && NON_US_COUNTRY_CODES.has(lastPart)) {
    return 'non_us';
  }

  // (B') Country-first format. Same collision space as (B), but for layouts
  // where the country code leads ("DE - Berlin", "CA-ON-MISSISSAUGA-...",
  // "IN-Pune"). Two signals justify the country reading over the state one:
  //   - a later part is a known foreign city ("DE - Berlin")
  //   - parts[0] and parts[1] are both short codes, i.e. a hierarchical
  //     country-region-city chain ("CA-ON-X", "ID-SM-Y") — US "ST - City"
  //     forms have a long city name in parts[1] ("CO - Denver"), not a code.
  // US-state-prefix forms ("CO - Denver", "AZ - Chandler") fall through to
  // (C) untouched.
  if (parts.length >= 2 && NON_US_COUNTRY_CODES.has(parts[0])) {
    for (let i = 1; i < parts.length; i++) {
      if (NON_US_CITY_HINTS.has(parts[i])) return 'non_us';
    }
    if (parts.length >= 3 && parts[0].length <= 3 && parts[1].length <= 3) {
      return 'non_us';
    }
  }

  // (C) Weak US: 2-letter state code in any delimited part. Tokens are
  // NOT checked here — 2-letter words like "in" (Indiana / English
  // preposition) and "or" (Oregon / conjunction) would false-match inside
  // free text like "Remote in Canada" or "Madrid or Barcelona".
  for (const part of parts) {
    if (US_STATE_CODES.has(part)) return 'us';
  }

  // (D) Negative US via parts — exact match against ISO country codes or
  // cleaned country names.
  for (const part of parts) {
    if (NON_US_COUNTRY_CODES.has(part)) return 'non_us';
    if (NON_US_COUNTRY_NAMES.has(part)) return 'non_us';
  }

  // (D2) Positive US via city hints — symmetric to (E) on the positive
  // side. Runs after (D) so "Boston, UK" still classifies as non-US (UK
  // wins in D), but bare "NYC" or "Working in San Francisco" no longer
  // falls through to 'unknown'.
  for (const part of parts) {
    if (US_CITY_HINTS.has(part)) return 'us';
  }
  for (const token of tokens) {
    if (US_CITY_HINTS.has(token)) return 'us';
  }
  for (const city of US_CITY_HINTS) {
    // Skip short abbreviations (nyc, dmv) in substring path — those are
    // already caught by parts/tokens above, and substring on 3-char strings
    // would risk matching inside unrelated words.
    if (city.length < 5) continue;
    if (trimmed.includes(city)) return 'us';
  }

  // (E) Substring fallback for unstructured strings ("Remote in Poland",
  // "Office: Bangalore"). Skip very short names that collide with English.
  for (const country of NON_US_COUNTRY_NAMES) {
    if (country.length < 5) continue;
    if (trimmed.includes(country)) return 'non_us';
  }
  for (const city of NON_US_CITY_HINTS) {
    if (trimmed.includes(city)) return 'non_us';
  }

  return 'unknown';
}
