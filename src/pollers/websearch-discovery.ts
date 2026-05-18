/**
 * WebSearch discovery poller.
 *
 * Uses Brave Search to discover NEW companies on known ATS platforms that are
 * not yet in data/companies.yml. This is purely additive - it grows the company
 * registry, it does not collect listings directly.
 *
 * URL patterns discovered:
 * - Greenhouse: site:boards.greenhouse.io "intern" "jobs"
 * - Lever:      site:jobs.lever.co "intern" "jobs"
 * - Ashby:      site:jobs.ashbyhq.com "intern" "jobs"
 *
 * Safeguard: verify search results are still live (not expired cache) before
 * adding to registry. Many cached job listings from search engines are months old.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const COMPANIES_YML_PATH = path.join(process.cwd(), 'data', 'companies.yml');
const SCAN_HISTORY_TSV = path.join(process.cwd(), 'data', 'scan-history.tsv');

// Brave Search API -- requires BRAVE_API_KEY env var. Silently skips if absent.
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const BRAVE_BASE = 'https://api.search.brave.com/res/v1/web/search';

/** Brave Search API call. Returns results array or [] on failure. */
async function braveSearch(query: string, count = 20): Promise<any[]> {
  if (!BRAVE_API_KEY) return [];
  try {
    const { data } = await axios.get(BRAVE_BASE, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      params: { q: query, count },
      timeout: 15_000,
    });
    return data?.web?.results?.items || [];
  } catch (e) {
    console.warn('[websearch-discovery] Brave API error:', e instanceof Error ? e.message : e);
    return [];
  }
}

// ── Title parsing patterns ──────────────────────────────────────────────────

// Match "Software Engineer Internship @ Company" or "SWE | Company"
const AT_RE_TITLE = /@\s*([A-Z][A-Za-z0-9 &.'-]+?)(?:\s*$|\s*[-–—]|\s*\|)/;
const PIPE_RE_TITLE = /\|\s*([A-Z][A-Za-z0-9 &.'-]+?)(?:\s*$|\s*[-–—])/;

// ── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredCompany {
  name: string;
  platform: 'greenhouse' | 'lever' | 'ashby';
  careersUrl: string;
  slug: string;
  verified: boolean; // true = we confirmed the board is live
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Load existing company names from companies.yml for dedup */
function loadExistingCompanies(): Set<string> {
  if (!fs.existsSync(COMPANIES_YML_PATH)) return new Set();
  const content = fs.readFileSync(COMPANIES_YML_PATH, 'utf8');
  const names = new Set<string>();
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*name:\s*["']([^"']+)["']/);
    if (m) names.add(m[1].trim());
  }
  return names;
}

/** Load already-discovered companies from scan history TSV */
function loadScanHistory(existingCompanies: Set<string>): Set<string> {
  const discovered = new Set<string>();
  if (!fs.existsSync(SCAN_HISTORY_TSV)) return discovered;
  const lines = fs.readFileSync(SCAN_HISTORY_TSV, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 2) {
      const name = parts[1].trim();
      if (name && !existingCompanies.has(name)) discovered.add(name);
    }
  }
  return discovered;
}

/** Append discovered companies to scan history TSV */
function appendScanHistory(discovered: DiscoveredCompany[], platform: string): void {
  const lines = discovered.map(
    (c) =>
      [new Date().toISOString(), c.name, platform, c.careersUrl, c.verified ? 'live' : 'unverified'].join(
        '\t',
      ),
  );
  fs.appendFileSync(SCAN_HISTORY_TSV, lines.join('\n') + '\n');
}

/**
 * Append verified new companies to data/companies.yml.
 * Writes YAML entries in the same format Lewandowski used.
 */
function writeNewCompaniesToRegistry(discovered: DiscoveredCompany[]): void {
  if (discovered.length === 0) return;
  const entries = discovered
    .map((c) => {
      const gh = c.platform === 'greenhouse' ? c.slug : null;
      const lev = c.platform === 'lever' ? c.slug : null;
      const ash = c.platform === 'ashby' ? c.slug : null;
      return [
        `- name: ${c.name}`,
        `  website: null`,
        `  greenhouse_slug: ${gh === null ? 'null' : gh}`,
        `  lever_slug: ${lev === null ? 'null' : lev}`,
        `  ashby_slug: ${ash === null ? 'null' : ash}`,
        `  careers_url: ${c.careersUrl}`,
        `  tier: tier_b`,
      ].join('\n');
    })
    .join('\n');

  fs.appendFileSync(COMPANIES_YML_PATH, entries + '\n');
  console.log(`[websearch-discovery] Added ${discovered.length} companies to companies.yml`);
}

/** Extract company name from a search result title */
function extractCompanyFromTitle(title: string): string | null {
  let m = title.match(AT_RE_TITLE);
  if (m) return m[1].trim();
  m = title.match(PIPE_RE_TITLE);
  if (m) return m[1].trim();
  m = title.match(/\bat\s+([A-Z][A-Za-z0-9 &.'-]+?)(?:\s*$|\s*[-–—])/i);
  if (m) return m[1].trim();
  return null;
}

/** Identify ATS platform from URL */
function identifyPlatform(url: string): 'greenhouse' | 'lever' | 'ashby' | null {
  if (url.includes('boards.greenhouse.io')) return 'greenhouse';
  if (url.includes('jobs.lever.co')) return 'lever';
  if (url.includes('jobs.ashbyhq.com')) return 'ashby';
  return null;
}

/** Extract slug from ATS job board URL */
function extractSlug(url: string, platform: 'greenhouse' | 'lever' | 'ashby'): string {
  if (platform === 'greenhouse') {
    const m = url.match(/boards\.greenhouse\.io\/([^\/]+)/);
    return m ? m[1] : '';
  }
  if (platform === 'lever') {
    const m = url.match(/jobs\.lever\.co\/([^\/]+)/);
    return m ? m[1] : '';
  }
  // ashby
  const m = url.match(/jobs\.ashbyhq\.com\/([^\/]+)/);
  return m ? m[1] : '';
}

/** Verify a company board is live by probing its API endpoint */
async function verifyBoardLive(
  platform: 'greenhouse' | 'lever' | 'ashby',
  slug: string,
): Promise<boolean> {
  try {
    if (platform === 'greenhouse') {
      const res = await axios.get(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
        { timeout: 5000, headers: { Accept: 'application/json' } },
      );
      return Array.isArray(res.data?.jobs);
    }
    if (platform === 'lever') {
      const res = await axios.get(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
        timeout: 5000,
        headers: { Accept: 'application/json' },
      });
      return Array.isArray(res.data);
    }
    // ashby
    const res = await axios.get(`https://jobs.ashbyhq.com/api/${slug}/postings`, {
      timeout: 5000,
      headers: { Accept: 'application/json' },
    });
    return Array.isArray(res.data?.jobs) || Array.isArray(res.data?.jobPostings);
  } catch {
    // any error = not live
  }
  return false;
}

// ── Discovery queries ─────────────────────────────────────────────────────────

const PLATFORM_QUERIES = [
  {
    platform: 'greenhouse' as const,
    query: 'site:boards.greenhouse.io "intern" "jobs" -jobboard -apply',
  },
  {
    platform: 'lever' as const,
    query: 'site:jobs.lever.co "intern" "jobs" -jobboard -apply',
  },
  {
    platform: 'ashby' as const,
    query: 'site:jobs.ashbyhq.com "intern" "jobs" -jobboard -apply',
  },
];

/**
 * Run one platform's discovery search and return raw candidates.
 * Does NOT add to registry -- just returns what was found.
 */
async function discoverPlatform(
  platform: 'greenhouse' | 'lever' | 'ashby',
  query: string,
  existingCompanies: Set<string>,
  alreadyDiscovered: Set<string>,
): Promise<DiscoveredCompany[]> {
  const results: DiscoveredCompany[] = [];
  const seenNames = new Set<string>();

  console.log(`[websearch-discovery] Searching ${platform}...`);
  const searchResults = await braveSearch(query, 20);

  for (const r of searchResults) {
    const name = extractCompanyFromTitle(r.title);
    if (!name) continue;
    const normalized = name.toLowerCase().trim();
    if (seenNames.has(normalized)) continue;
    if (existingCompanies.has(name)) continue;
    if (alreadyDiscovered.has(name)) continue;
    if (name.length < 2 || name.length > 60) continue;
    if (/^(the|and|or|for|at)\s+/i.test(name)) continue;

    seenNames.add(normalized);

    const urlPlatform = identifyPlatform(r.url);
    if (!urlPlatform || urlPlatform !== platform) continue;

    const slug = extractSlug(r.url, platform);
    if (!slug) continue;

    const careersUrl =
      platform === 'greenhouse'
        ? `https://boards.greenhouse.io/${slug}`
        : platform === 'lever'
          ? `https://jobs.lever.co/${slug}`
          : `https://jobs.ashbyhq.com/${slug}`;

    results.push({ name, platform, careersUrl, slug, verified: false });
  }

  console.log(`[websearch-discovery] ${platform}: raw candidates=${results.length}`);
  return results;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run all three platform searches, verify candidates live, log to scan history,
 * and return the new verified entries.
 */
export async function pollWebsearchDiscovery(): Promise<DiscoveredCompany[]> {
  const existingCompanies = loadExistingCompanies();
  const alreadyDiscovered = loadScanHistory(existingCompanies);

  const allNew: DiscoveredCompany[] = [];

  for (const { platform, query } of PLATFORM_QUERIES) {
    const candidates = await discoverPlatform(
      platform,
      query,
      existingCompanies,
      alreadyDiscovered,
    );

    // Verify live in batches of 5 to avoid hammering APIs
    const verified: DiscoveredCompany[] = [];
    for (let i = 0; i < candidates.length; i += 5) {
      const batch = candidates.slice(i, i + 5);
      await Promise.all(
        batch.map(async (c) => {
          c.verified = await verifyBoardLive(c.platform, c.slug);
        }),
      );
      verified.push(...batch);
      // polite delay between batches
      await new Promise((r) => setTimeout(r, 1000));
    }

    const live = verified.filter((c) => c.verified);
    const unverified = verified.filter((c) => !c.verified);

    console.log(
      `[websearch-discovery] ${platform}: ${live.length} live, ${unverified.length} unverified (cache/dead)`,
    );

    if (live.length > 0) {
      appendScanHistory(live, platform);
      writeNewCompaniesToRegistry(live);
      allNew.push(...live);
    }
  }

  console.log(`[websearch-discovery] Total new companies found: ${allNew.length}`);
  return allNew;
}
