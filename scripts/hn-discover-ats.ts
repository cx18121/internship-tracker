/**
 * Discover new Greenhouse / Lever / Ashby boards by mining HN comments via
 * Algolia's free search API. Companies posting in "Who is hiring?" threads
 * (and Show HN, Ask HN, etc.) routinely include their ATS-board URLs inline,
 * so we extract the slug, verify the board is live, and append to
 * data/ats-targets.json.
 *
 * Usage:
 *   npx tsx scripts/hn-discover-ats.ts
 *   npx tsx scripts/hn-discover-ats.ts --dry-run
 *   npx tsx scripts/hn-discover-ats.ts --ats greenhouse
 *
 * Free Algolia tier caps each query at ~1000 hits. We bucket by year on
 * created_at_i to push past that — yearly buckets keep every density under
 * the cap as of 2026.
 */

import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const ATS_TARGETS_PATH = path.join(process.cwd(), 'data', 'ats-targets.json');
const HN_BASE = 'https://hn.algolia.com/api/v1/search';
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_CONCURRENCY = 10;

type ATS = 'greenhouse' | 'lever' | 'ashby';
const SUPPORTED_ATS: readonly ATS[] = ['greenhouse', 'lever', 'ashby'] as const;

interface ATSTarget {
  slug: string;
  ats: string;
  name?: string;
  [k: string]: unknown;
}
interface ATSTargetsFile {
  targets: ATSTarget[];
  [k: string]: unknown;
}

interface AlgoliaHit {
  comment_text?: string;
  story_id?: number;
  created_at_i?: number;
  objectID?: string;
}
interface AlgoliaSearchResp {
  hits: AlgoliaHit[];
  nbHits: number;
  nbPages: number;
}

const ATS_PATTERNS: { ats: ATS; needle: string; re: RegExp }[] = [
  {
    ats: 'greenhouse',
    needle: 'boards.greenhouse.io',
    re: /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9._-]{1,60})/gi,
  },
  { ats: 'lever', needle: 'jobs.lever.co',    re: /jobs\.lever\.co\/([a-z0-9][a-z0-9._-]{1,60})/gi },
  { ats: 'ashby', needle: 'jobs.ashbyhq.com', re: /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9._-]{1,60})/gi },
];

// Path segments that aren't tenant slugs.
const NON_SLUGS = new Set([
  'embed', 'jobs', 'careers', 'api', 'company', 'login', 'auth', 'oauth', 'static',
]);

// ---------------------------------------------------------------------------
// Algolia HN search
// ---------------------------------------------------------------------------

async function searchOnce(needle: string, page: number, dateFilter: string): Promise<AlgoliaSearchResp> {
  const { data } = await axios.get<AlgoliaSearchResp>(HN_BASE, {
    params: { query: needle, tags: 'comment', hitsPerPage: 100, page, numericFilters: dateFilter },
    timeout: 30_000,
  });
  return data;
}

async function searchAllPages(needle: string, dateFilter: string): Promise<AlgoliaHit[]> {
  const first = await searchOnce(needle, 0, dateFilter);
  const all = [...first.hits];
  // Algolia caps at ~50 pages (1000 hits). Walk until we hit it or run out.
  const maxPage = Math.min(first.nbPages, 50);
  for (let p = 1; p < maxPage; p++) {
    const r = await searchOnce(needle, p, dateFilter);
    all.push(...r.hits);
    if (r.hits.length === 0) break;
  }
  return all;
}

function unixYear(year: number): number {
  return Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000);
}

function yearBuckets(): { label: string; filter: string }[] {
  const now = Math.floor(Date.now() / 1000);
  const thisYear = new Date().getFullYear();
  const buckets = [{ label: '<2015', filter: `created_at_i<${unixYear(2015)}` }];
  for (let y = 2015; y <= thisYear; y++) {
    const start = unixYear(y);
    const end = y === thisYear ? now : unixYear(y + 1);
    buckets.push({ label: String(y), filter: `created_at_i>=${start},created_at_i<${end}` });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Slug extraction
// ---------------------------------------------------------------------------

// HN's Algolia API returns comment_text with HTML entities (e.g. `&#x2F;` for
// `/`), so URLs read as `https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;slug`.
// Decode the entities that affect URL parsing before running the slug regex.
function decodeHnEntities(s: string): string {
  return s
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function extractSlugs(text: string, re: RegExp): Set<string> {
  const decoded = decodeHnEntities(text);
  const out = new Set<string>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decoded))) {
    const slug = m[1].toLowerCase().replace(/[.,;)\]'"]+$/, '');
    if (!NON_SLUGS.has(slug) && slug.length >= 2) out.add(slug);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slug verification — same logic as scripts/exa-discover-ats.ts
// ---------------------------------------------------------------------------

async function verifySlug(slug: string, ats: ATS): Promise<boolean> {
  try {
    if (ats === 'greenhouse') {
      const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
      const res = await axios.get(url, { timeout: VERIFY_TIMEOUT_MS, validateStatus: () => true });
      return res.status === 200 && Array.isArray(res.data?.jobs);
    }
    if (ats === 'lever') {
      const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
      const res = await axios.get(url, { timeout: VERIFY_TIMEOUT_MS, validateStatus: () => true });
      return res.status === 200 && Array.isArray(res.data);
    }
    if (ats === 'ashby') {
      const url = `https://jobs.ashbyhq.com/${slug}`;
      const res = await axios.get<string>(url, {
        timeout: VERIFY_TIMEOUT_MS, validateStatus: () => true, responseType: 'text',
      });
      if (res.status !== 200 || typeof res.data !== 'string') return false;
      const m = res.data.match(/window\.__appData\s*=\s*(\{.*?\});\s*\n/s);
      if (!m) return false;
      try { return Array.isArray(JSON.parse(m[1])?.jobBoard?.jobPostings); } catch { return false; }
    }
  } catch { return false; }
  return false;
}

async function verifyAll(candidates: { ats: ATS; slug: string }[]): Promise<{ ats: ATS; slug: string }[]> {
  const verified: { ats: ATS; slug: string }[] = [];
  let idx = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= candidates.length) return;
      const c = candidates[i];
      const ok = await verifySlug(c.slug, c.ats);
      done++;
      if (ok) verified.push(c);
      if (done % 100 === 0) {
        process.stdout.write(`  ...${done}/${candidates.length} (verified=${verified.length})\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, () => worker()));
  return verified;
}

function slugToName(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Discovery for one ATS
// ---------------------------------------------------------------------------

async function discoverATS(ats: ATS, existing: Set<string>): Promise<{ ats: ATS; slug: string }[]> {
  const pat = ATS_PATTERNS.find(p => p.ats === ats)!;
  console.log(`\n── ${ats} (${pat.needle}) ──`);
  const mined = new Set<string>();
  for (const bucket of yearBuckets()) {
    const hits = await searchAllPages(pat.needle, bucket.filter);
    let bucketSlugs = 0;
    for (const hit of hits) {
      if (!hit.comment_text) continue;
      for (const s of extractSlugs(hit.comment_text, pat.re)) {
        mined.add(s);
        bucketSlugs++;
      }
    }
    console.log(`  ${bucket.label.padEnd(6)} ${hits.length.toString().padStart(4)} comments → ${bucketSlugs} slug refs`);
  }
  const fresh = Array.from(mined).filter(s => !existing.has(`${ats}:${s}`));
  console.log(`  Unique: ${mined.size}; new (vs ats-targets): ${fresh.length}`);
  return fresh.map(slug => ({ ats, slug }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const atsArgIdx = args.indexOf('--ats');
  const onlyATS = atsArgIdx >= 0 ? args[atsArgIdx + 1] : null;

  const config = JSON.parse(fs.readFileSync(ATS_TARGETS_PATH, 'utf-8')) as ATSTargetsFile;
  const existing = new Set<string>(
    config.targets.map(t => `${t.ats}:${t.slug.toLowerCase()}`),
  );
  console.log(`[hn-discover] Loaded ${config.targets.length} existing targets`);

  const atsToCheck = onlyATS
    ? SUPPORTED_ATS.filter(a => a === onlyATS)
    : SUPPORTED_ATS;
  if (atsToCheck.length === 0) {
    console.error(`Unknown --ats value. Supported: ${SUPPORTED_ATS.join(', ')}`);
    process.exit(1);
  }

  const allCandidates: { ats: ATS; slug: string }[] = [];
  for (const ats of atsToCheck) {
    const cands = await discoverATS(ats, existing);
    allCandidates.push(...cands);
  }

  console.log(`\n=== Verifying ${allCandidates.length} candidates (concurrency=${VERIFY_CONCURRENCY}) ===`);
  const verified = await verifyAll(allCandidates);
  console.log(`\n=== Result ===`);
  console.log(`Verified live: ${verified.length}`);
  console.log(`Failed:        ${allCandidates.length - verified.length}`);
  const byAts: Record<string, number> = {};
  for (const v of verified) byAts[v.ats] = (byAts[v.ats] || 0) + 1;
  console.log(`By ATS:`, byAts);

  if (verified.length === 0) {
    console.log('[hn-discover] Nothing to add.');
    return;
  }

  if (dryRun) {
    console.log('\n--- dry run; would append: ---');
    for (const v of verified) console.log(`  ${v.ats}/${v.slug}`);
    return;
  }

  const toAppend: ATSTarget[] = verified.map(v => ({
    slug: v.slug,
    ats: v.ats,
    name: slugToName(v.slug),
  }));
  config.targets.push(...toAppend);
  fs.writeFileSync(ATS_TARGETS_PATH, JSON.stringify(config, null, 2));
  console.log(`\n[hn-discover] Wrote ${toAppend.length} new targets to ${ATS_TARGETS_PATH}`);
}

main().catch(err => {
  if (axios.isAxiosError(err)) {
    console.error('axios error', err.response?.status, err.response?.data || err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
