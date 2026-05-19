/**
 * Discover new Greenhouse / Lever / Ashby boards via Exa search, verify each
 * candidate is live, and append fresh entries to data/ats-targets.json.
 *
 * Usage:
 *   EXA_API_KEY=... npx tsx scripts/exa-discover-ats.ts
 *   EXA_API_KEY=... npx tsx scripts/exa-discover-ats.ts --dry-run
 *   EXA_API_KEY=... npx tsx scripts/exa-discover-ats.ts --ats greenhouse
 *
 * Cost: one Exa /search call per ATS (3 by default). Verifies every candidate
 * with an HTTP request to the matching public board API.
 */

import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const ATS_TARGETS_PATH = path.join(process.cwd(), 'data', 'ats-targets.json');
const RESULTS_PER_ATS = parseInt(process.env.EXA_NUM_RESULTS || '50', 10);
const VERIFY_TIMEOUT_MS = 8000;

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

interface ExaResult { url: string; title?: string }
interface ExaSearchResponse { results: ExaResult[] }

// ---------------------------------------------------------------------------
// Exa API
// ---------------------------------------------------------------------------

async function exaSearch(query: string, numResults: number): Promise<string[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error('EXA_API_KEY not set');
  const { data } = await axios.post<ExaSearchResponse>(
    EXA_SEARCH_URL,
    { query, numResults, type: 'keyword' },
    { headers: { 'x-api-key': apiKey }, timeout: 30000 },
  );
  return (data.results ?? []).map(r => r.url).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Slug extraction
// ---------------------------------------------------------------------------

function extractSlug(url: string, ats: ATS): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const pathname = u.pathname;
    if (ats === 'greenhouse') {
      // boards.greenhouse.io/{slug}/... or job-boards.greenhouse.io/{slug}/...
      if (!host.endsWith('greenhouse.io')) return null;
      const m = pathname.match(/^\/([^/]+)/);
      return m ? m[1].toLowerCase() : null;
    }
    if (ats === 'lever') {
      // jobs.lever.co/{slug}/...
      if (host !== 'jobs.lever.co') return null;
      const m = pathname.match(/^\/([^/]+)/);
      return m ? m[1].toLowerCase() : null;
    }
    if (ats === 'ashby') {
      // jobs.ashbyhq.com/{slug}/...
      if (host !== 'jobs.ashbyhq.com') return null;
      const m = pathname.match(/^\/([^/]+)/);
      return m ? m[1].toLowerCase() : null;
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slug verification — confirm the board actually exists
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
        timeout: VERIFY_TIMEOUT_MS,
        validateStatus: () => true,
        responseType: 'text',
      });
      // Ashby always returns 200 even for invalid slugs (SPA); look for appData
      // with non-empty jobPostings.
      if (res.status !== 200 || typeof res.data !== 'string') return false;
      const m = res.data.match(/window\.__appData\s*=\s*(\{.*?\});\s*\n/s);
      if (!m) return false;
      try {
        const parsed = JSON.parse(m[1]);
        return Array.isArray(parsed?.jobBoard?.jobPostings);
      } catch {
        return false;
      }
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Slug → display name
// ---------------------------------------------------------------------------

function slugToName(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Discovery for one ATS
// ---------------------------------------------------------------------------

async function discoverATS(
  ats: ATS,
  existing: Set<string>,
): Promise<ATSTarget[]> {
  const domain =
    ats === 'greenhouse' ? 'boards.greenhouse.io'
    : ats === 'lever' ? 'jobs.lever.co'
    : 'jobs.ashbyhq.com';
  const query = `site:${domain} intern`;
  console.log(`\n[exa-discover] ${ats}: query="${query}"`);

  let urls: string[];
  try {
    urls = await exaSearch(query, RESULTS_PER_ATS);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[exa-discover] ${ats}: Exa search failed — ${msg}`);
    return [];
  }
  console.log(`[exa-discover] ${ats}: ${urls.length} URLs returned`);

  const candidateSlugs = new Set<string>();
  for (const url of urls) {
    const slug = extractSlug(url, ats);
    if (slug) candidateSlugs.add(slug);
  }
  console.log(`[exa-discover] ${ats}: ${candidateSlugs.size} unique slugs after parsing`);

  const known = Array.from(candidateSlugs).filter(s => existing.has(`${ats}:${s}`));
  const fresh = Array.from(candidateSlugs).filter(s => !existing.has(`${ats}:${s}`));
  console.log(`[exa-discover] ${ats}: ${known.length} already-tracked, ${fresh.length} new candidates`);

  const verified: ATSTarget[] = [];
  for (const slug of fresh) {
    const ok = await verifySlug(slug, ats);
    if (ok) {
      verified.push({ slug, ats, name: slugToName(slug) });
      console.log(`  ✓ ${slug}`);
    } else {
      console.log(`  ✗ ${slug}  (verify failed)`);
    }
    // Be a polite neighbor — small delay between verifies
    await new Promise(r => setTimeout(r, 200));
  }

  return verified;
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
  console.log(`[exa-discover] Loaded ${config.targets.length} existing targets`);

  const atsToCheck = onlyATS
    ? SUPPORTED_ATS.filter(a => a === onlyATS)
    : SUPPORTED_ATS;
  if (atsToCheck.length === 0) {
    console.error(`Unknown --ats value. Supported: ${SUPPORTED_ATS.join(', ')}`);
    process.exit(1);
  }

  const allNew: ATSTarget[] = [];
  for (const ats of atsToCheck) {
    const newOnes = await discoverATS(ats, existing);
    for (const t of newOnes) {
      const key = `${t.ats}:${t.slug.toLowerCase()}`;
      if (existing.has(key)) continue; // double-check
      allNew.push(t);
      existing.add(key);
    }
  }

  console.log(`\n[exa-discover] Total new verified targets: ${allNew.length}`);
  if (allNew.length === 0) {
    console.log('[exa-discover] Nothing to add.');
    return;
  }

  if (dryRun) {
    console.log('--- dry run; would append: ---');
    for (const t of allNew) console.log(`  ${t.ats}/${t.slug}`);
    return;
  }

  config.targets.push(...allNew);
  fs.writeFileSync(ATS_TARGETS_PATH, JSON.stringify(config, null, 2));
  console.log(`[exa-discover] Wrote ${allNew.length} new targets to ${ATS_TARGETS_PATH}`);
}

main().catch(err => {
  console.error('[exa-discover] Fatal:', err);
  process.exit(1);
});
