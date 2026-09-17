/**
 * Map a posting's raw location strings to a small set of metros the filter
 * chips use. Deterministic: table lookup on lower-cased text with word
 * boundaries. A posting gets one metro per distinct location it lists.
 */

export const METROS = ['bay', 'nyc', 'seattle', 'boston', 'la', 'chicago', 'austin', 'remote', 'other'] as const;
export type Metro = (typeof METROS)[number];

export const METRO_LABELS: Record<Metro, string> = {
  bay: 'Bay Area',
  nyc: 'NYC',
  seattle: 'Seattle',
  boston: 'Boston',
  la: 'Los Angeles',
  chicago: 'Chicago',
  austin: 'Austin',
  remote: 'Remote',
  other: 'Other',
};

// Phrases that place a location in a metro. Matched on word boundaries
// against the lower-cased string, longest phrases first, so "south san
// francisco" and "san francisco" both land in bay and "cambridge" only counts
// with a Massachusetts marker.
const CITY_PHRASES: Array<[Metro, string[]]> = [
  ['bay', [
    'san francisco', 'sf', 'south sf', 'south san francisco', 'bay area', 'silicon valley',
    'palo alto', 'mountain view', 'menlo park', 'redwood city', 'san jose', 'santa clara', 'sunnyvale',
    'cupertino', 'fremont', 'oakland', 'berkeley', 'san mateo', 'foster city', 'burlingame', 'milpitas',
    'emeryville', 'pleasanton', 'san bruno', 'san carlos', 'belmont', 'los altos', 'campbell', 'newark, ca',
  ]],
  ['nyc', ['new york', 'nyc', 'manhattan', 'brooklyn', 'jersey city', 'hoboken', 'long island city', 'queens']],
  ['seattle', ['seattle', 'bellevue', 'redmond', 'kirkland']],
  ['boston', ['boston', 'cambridge, ma', 'cambridge, massachusetts', 'somerville', 'waltham', 'burlington, ma', 'lexington, ma', 'needham']],
  ['la', ['los angeles', 'santa monica', 'el segundo', 'pasadena', 'culver city', 'playa vista', 'venice, ca', 'hawthorne', 'long beach', 'irvine', 'burbank', 'torrance', 'glendale, ca']],
  ['chicago', ['chicago', 'evanston', 'naperville', 'schaumburg']],
  ['austin', ['austin', 'round rock']],
];

const REMOTE_RE = /\b(remote|work from home|wfh|anywhere)\b/i;

function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(^|[^a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z])`).test(text);
}

/** Metro for one raw location string. Non-US strings should be filtered out before this. */
export function metroFor(location: string): Metro {
  const text = location.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return 'other';
  for (const [metro, phrases] of CITY_PHRASES) {
    if (phrases.some(p => hasPhrase(text, p))) return metro;
  }
  if (REMOTE_RE.test(text)) return 'remote';
  return 'other';
}

/** Distinct metros for a posting, in METROS order. */
export function metrosFor(locations: readonly string[]): Metro[] {
  const found = new Set(locations.map(metroFor));
  return METROS.filter(m => found.has(m));
}
