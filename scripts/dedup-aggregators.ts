/**
 * Deduplicate aggregator links (LinkedIn/Indeed → direct ATS)
 *
 * Rule: For listings with ONLY aggregator links (no direct ATS URL exists),
 * DO NOT remove — keep them as they're the only path to apply.
 *
 * For each LinkedIn/Indeed listing, check if a duplicate from the same
 * company exists with a direct ATS URL (greenhouse, lever, ashby, workday, etc).
 * If direct ATS version exists → remove the aggregator entry.
 * If no direct ATS version → keep the aggregator link.
 */

import * as path from 'path';
import * as fs from 'fs';

// Resolve data directory relative to project root
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const INTERNSHIPS_FILE = path.join(DATA_DIR, 'internships.json');

interface Internship {
  id: string;
  title: string;
  company: string;
  location: string;
  link: string;
  source: string;
  postedAt: string;
  seenAt: string;
  score: number | null;
  scoreLabel: string;
  matchedKeywords: string[];
  isNew: boolean;
  applied: boolean;
  // Added by scoring engine
  score_breakdown?: Record<string, number>;
  grade?: string;
  // Fields potentially added later
  failedCheckCount?: number;
  archived?: boolean;
  [key: string]: unknown;
}

// ATS sources that count as "direct"
const ATS_SOURCES = new Set([
  'greenhouse', 'lever', 'ashby', 'workday', 'icims',
  'smartrecruiters', 'bamboohr', 'jobvite', 'taleo',
  'brassring', 'applyto', 'halogensoftware'
]);

function isAtsSource(source: string): boolean {
  const s = source.toLowerCase();
  return ATS_SOURCES.has(s) || s.includes('greenhouse') || s.includes('lever') ||
         s.includes('ashby') || s.includes('workday');
}

function isAggregator(source: string): boolean {
  const s = source.toLowerCase();
  return s === 'linkedin' || s === 'indeed' || s === 'linkedin/indeed';
}

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function titleSimilar(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  // Check if one is a substring of the other
  return na.includes(nb) || nb.includes(na);
}

function loadInternships(): Internship[] {
  if (!fs.existsSync(INTERNSHIPS_FILE)) {
    throw new Error(`File not found: ${INTERNSHIPS_FILE}`);
  }
  const raw = fs.readFileSync(INTERNSHIPS_FILE, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : (data.internships ?? data.data ?? []);
}

function saveInternships(internships: Internship[]): void {
  const tmp = INTERNSHIPS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(internships, null, 2), 'utf8');
  fs.renameSync(tmp, INTERNSHIPS_FILE);
}

async function main() {
  console.log('[dedup-aggregators] Starting...');
  console.log('[dedup-aggregators] Data file:', INTERNSHIPS_FILE);

  const internships = loadInternships();
  console.log(`[dedup-aggregators] Loaded ${internships.length} total listings`);

  // Partition
  const aggregatorEntries = internships.filter(i => isAggregator(i.source));
  const directAtsEntries = internships.filter(i => isAtsSource(i.source));
  const otherEntries = internships.filter(i => !isAggregator(i.source) && !isAtsSource(i.source));

  console.log(`[dedup-aggregators] Aggregator (LinkedIn/Indeed): ${aggregatorEntries.length}`);
  console.log(`[dedup-aggregators] Direct ATS: ${directAtsEntries.length}`);
  console.log(`[dedup-aggregators] Other: ${otherEntries.length}`);

  // Build a map of company → list of direct ATS listings (by normalized company name)
  const atsByCompany = new Map<string, Internship[]>();
  for (const entry of directAtsEntries) {
    const key = normalize(entry.company);
    if (!atsByCompany.has(key)) atsByCompany.set(key, []);
    atsByCompany.get(key)!.push(entry);
  }

  // For each aggregator entry, check if a matching direct ATS entry exists
  const toRemove = new Set<string>();
  let duplicatesFound = 0;
  let loneAggregators = 0;

  for (const agg of aggregatorEntries) {
    const key = normalize(agg.company);
    const candidates = atsByCompany.get(key) ?? [];

    const match = candidates.find(c =>
      titleSimilar(agg.title, c.title)
    );

    if (match) {
      duplicatesFound++;
      toRemove.add(agg.id);
    } else {
      loneAggregators++;
    }
  }

  console.log(`\n[dedup-aggregators] Results:`);
  console.log(`  Duplicates found (aggregator has direct ATS equivalent): ${duplicatesFound}`);
  console.log(`  Lone aggregators (no direct ATS, will be kept): ${loneAggregators}`);

  if (duplicatesFound === 0) {
    console.log('[dedup-aggregators] No duplicates to remove. Nothing to do.');
    return;
  }

  // Build new list: exclude aggregator entries that have direct ATS equivalents
  const remaining = [
    ...otherEntries,
    ...directAtsEntries,
    ...aggregatorEntries.filter(a => !toRemove.has(a.id))
  ];

  const removedCount = internships.length - remaining.length;
  console.log(`[dedup-aggregators] Removing ${removedCount} aggregator entries (direct ATS versions exist)`);
  console.log(`[dedup-aggregators] Remaining listings: ${remaining.length}`);

  saveInternships(remaining);

  // Show some examples of what was removed
  const removed = internships.filter(i => toRemove.has(i.id)).slice(0, 5);
  console.log('\nExamples of removed aggregator duplicates:');
  for (const r of removed) {
    const key = normalize(r.company);
    const match = (atsByCompany.get(key) ?? []).find(c => titleSimilar(r.title, c.title));
    console.log(`  REMOVE: [${r.source}] ${r.company} — "${r.title}"`);
    console.log(`    KEEP:  [${match?.source}] ${match?.company} — "${match?.title}"`);
    console.log();
  }

  console.log('[dedup-aggregators] Done.');
}

main().catch(console.error);
