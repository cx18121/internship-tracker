/**
 * Compare Exa prompting strategies for ATS discovery. Tests several variants
 * against Greenhouse only (cheapest single-ATS sample), reports raw → unique →
 * new → verified yields so we can pick the strongest before committing the
 * main script to a strategy.
 *
 * Usage:  EXA_API_KEY=... npx tsx scripts/exa-compare.ts [--write]
 *
 * --write applies the union of all new-verified targets to ats-targets.json
 * (default is read-only comparison).
 */

import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const ATS_TARGETS_PATH = path.join(process.cwd(), 'data', 'ats-targets.json');
const VERIFY_TIMEOUT_MS = 8000;

interface ATSTarget { slug: string; ats: string; name?: string }
interface ExaResult { url: string; title?: string }

const apiKey = process.env.EXA_API_KEY;
if (!apiKey) { console.error('EXA_API_KEY not set'); process.exit(1); }

async function exaSearch(body: Record<string, unknown>): Promise<string[]> {
  try {
    const { data } = await axios.post<{ results: ExaResult[] }>(
      'https://api.exa.ai/search',
      body,
      { headers: { 'x-api-key': apiKey }, timeout: 30000 },
    );
    return (data.results ?? []).map(r => r.url).filter(Boolean);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  ! /search failed: ${msg}`);
    return [];
  }
}

async function exaFindSimilar(seedUrl: string, numResults: number): Promise<string[]> {
  try {
    const { data } = await axios.post<{ results: ExaResult[] }>(
      'https://api.exa.ai/findSimilar',
      { url: seedUrl, numResults, excludeSourceDomain: false },
      { headers: { 'x-api-key': apiKey }, timeout: 30000 },
    );
    return (data.results ?? []).map(r => r.url).filter(Boolean);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  ! /findSimilar(${seedUrl}) failed: ${msg}`);
    return [];
  }
}

function extractGreenhouseSlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith('greenhouse.io')) return null;
    const m = u.pathname.match(/^\/([^/]+)/);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

async function verifyGreenhouse(slug: string): Promise<boolean> {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    const res = await axios.get(url, { timeout: VERIFY_TIMEOUT_MS, validateStatus: () => true });
    return res.status === 200 && Array.isArray(res.data?.jobs);
  } catch { return false; }
}

interface Strategy {
  name: string;
  apiCalls: number;       // for cost reporting
  run: () => Promise<string[]>;
}

const STRATEGIES: Strategy[] = [
  {
    name: 'A: keyword + site:domain intern',
    apiCalls: 1,
    run: () => exaSearch({
      query: 'site:boards.greenhouse.io intern',
      numResults: 50,
      type: 'keyword',
    }),
  },
  {
    name: 'B: neural + site:domain intern',
    apiCalls: 1,
    run: () => exaSearch({
      query: 'site:boards.greenhouse.io intern',
      numResults: 50,
      // omit type → neural default
    }),
  },
  {
    name: 'C: neural + richer query + autoprompt',
    apiCalls: 1,
    run: () => exaSearch({
      query: 'company career page with software engineering internship listings on greenhouse',
      numResults: 50,
      useAutoprompt: true,
    }),
  },
  {
    name: 'D: findSimilar from 1 seed (stripe)',
    apiCalls: 1,
    run: () => exaFindSimilar('https://boards.greenhouse.io/stripe', 50),
  },
  {
    name: 'E: findSimilar from 5 diverse seeds',
    apiCalls: 5,
    run: async () => {
      const seeds = [
        'https://boards.greenhouse.io/stripe',
        'https://boards.greenhouse.io/anthropic',
        'https://boards.greenhouse.io/figma',
        'https://boards.greenhouse.io/databricks',
        'https://boards.greenhouse.io/airbnb',
      ];
      const all: string[] = [];
      for (const s of seeds) {
        all.push(...await exaFindSimilar(s, 25));
      }
      return all;
    },
  },
];

interface Result {
  name: string;
  apiCalls: number;
  rawUrls: number;
  uniqueSlugs: number;
  newCandidates: number;
  verified: number;
  yieldPerCall: number;
  newSlugs: string[];
}

async function main(): Promise<void> {
  const writeMode = process.argv.includes('--write');

  const config = JSON.parse(fs.readFileSync(ATS_TARGETS_PATH, 'utf-8')) as { targets: ATSTarget[] };
  const existing = new Set(
    config.targets
      .filter(t => t.ats === 'greenhouse')
      .map(t => t.slug.toLowerCase()),
  );
  console.log(`Loaded ${existing.size} existing greenhouse targets\n`);

  const results: Result[] = [];

  for (const strat of STRATEGIES) {
    console.log(`\n── ${strat.name} (${strat.apiCalls} call${strat.apiCalls > 1 ? 's' : ''}) ──`);
    const raw = await strat.run();

    const slugs = new Set<string>();
    for (const url of raw) {
      const slug = extractGreenhouseSlug(url);
      if (slug) slugs.add(slug);
    }
    const fresh = Array.from(slugs).filter(s => !existing.has(s));

    let verified = 0;
    const verifiedSlugs: string[] = [];
    for (const slug of fresh) {
      const ok = await verifyGreenhouse(slug);
      if (ok) { verified++; verifiedSlugs.push(slug); }
      await new Promise(r => setTimeout(r, 150));
    }

    const result: Result = {
      name: strat.name,
      apiCalls: strat.apiCalls,
      rawUrls: raw.length,
      uniqueSlugs: slugs.size,
      newCandidates: fresh.length,
      verified,
      yieldPerCall: verified / strat.apiCalls,
      newSlugs: verifiedSlugs,
    };
    results.push(result);

    console.log(`  raw URLs: ${result.rawUrls}`);
    console.log(`  unique slugs: ${result.uniqueSlugs}`);
    console.log(`  new candidates (not in ats-targets): ${result.newCandidates}`);
    console.log(`  verified live: ${result.verified}`);
    if (verifiedSlugs.length > 0) {
      console.log(`  → ${verifiedSlugs.slice(0, 10).join(', ')}${verifiedSlugs.length > 10 ? '...' : ''}`);
    }
  }

  console.log('\n\n══ Summary ══════════════════════════════════════════════════════');
  console.log('Strategy                                         calls  raw  uniq  new  verif  yield/call');
  for (const r of results) {
    const name = r.name.padEnd(48);
    console.log(`${name} ${String(r.apiCalls).padStart(5)}  ${String(r.rawUrls).padStart(3)}  ${String(r.uniqueSlugs).padStart(4)}  ${String(r.newCandidates).padStart(3)}  ${String(r.verified).padStart(5)}  ${r.yieldPerCall.toFixed(1)}`);
  }

  // Union of all new verified slugs across strategies
  const union = new Set<string>();
  for (const r of results) for (const s of r.newSlugs) union.add(s);
  console.log(`\nUnion of all new verified slugs: ${union.size}`);

  if (writeMode && union.size > 0) {
    const newTargets: ATSTarget[] = Array.from(union).map(slug => ({
      slug,
      ats: 'greenhouse',
      name: slug.replace(/-/g, ' ').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    }));
    config.targets.push(...newTargets);
    fs.writeFileSync(ATS_TARGETS_PATH, JSON.stringify(config, null, 2));
    console.log(`\n✓ Wrote ${newTargets.length} new targets to ${ATS_TARGETS_PATH}`);
  } else if (!writeMode) {
    console.log('\n(Use --write to commit the union to ats-targets.json.)');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
