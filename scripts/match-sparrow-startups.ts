/**
 * Match Sparrow's curated startup database (~6.3k YC/a16z/Sequoia/Kleiner/Greylock
 * companies in Supabase) to Greenhouse / Lever / Ashby / SmartRecruiters boards
 * by guessing ATS slug variants and verifying via each ATS's public API.
 *
 * Usage:
 *   SPARROW_DATABASE_URL=... npx tsx scripts/match-sparrow-startups.ts [--dry-run] [--hiring-only] [--limit N]
 *
 * Convenience for local runs (reads sparrow's .env automatically):
 *   npm run match:sparrow -- --dry-run
 *
 * Writes verified hits to data/ats-targets.json with source: 'sparrow'.
 */

import 'dotenv/config';
import axios from 'axios';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ATS_TARGETS_PATH = path.join(process.cwd(), 'data', 'ats-targets.json');
const VERIFY_TIMEOUT_MS = 6000;
const WORKER_CONCURRENCY = parseInt(process.env.MATCH_CONCURRENCY || '10', 10);

type ATS = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters';
const ATS_LIST: readonly ATS[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'] as const;

interface SparrowCompany {
  name: string;
  domain: string;
  isHiring: boolean;
  industry: string | null;
}

interface ATSTarget {
  slug: string;
  ats: string;
  name?: string;
  source?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sparrow connection — falls back to reading ~/School/Clubs/genai/sparrow/.env
// ---------------------------------------------------------------------------

function resolveSparrowDatabaseUrl(): string {
  if (process.env.SPARROW_DATABASE_URL) return process.env.SPARROW_DATABASE_URL;
  // Look up sparrow's .env relative to this user's home dir (best-effort)
  const guesses = [
    path.join(os.homedir(), 'School', 'Clubs', 'genai', 'sparrow', '.env'),
    path.join(os.homedir(), 'sparrow', '.env'),
  ];
  for (const p of guesses) {
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      // Prefer DIRECT_URL (no pgbouncer, simpler for one-shot queries).
      const direct = raw.match(/^DIRECT_URL\s*=\s*"?([^"\n]+)"?/m);
      if (direct) return direct[1];
      const pooled = raw.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
      if (pooled) return pooled[1];
    } catch {
      // try next
    }
  }
  throw new Error('SPARROW_DATABASE_URL not set and no sparrow/.env found');
}

async function fetchSparrowCompanies(hiringOnly: boolean, limit: number | null): Promise<SparrowCompany[]> {
  const url = resolveSparrowDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const where = hiringOnly ? `WHERE "isHiring" = true` : '';
    const lim = limit ? `LIMIT ${limit}` : '';
    const sql = `SELECT name, domain, "isHiring", industry FROM "Company" ${where} ORDER BY name ${lim}`;
    const { rows } = await client.query(sql);
    return rows.map(r => ({
      name: r.name,
      domain: r.domain,
      isHiring: r.isHiring ?? false,
      industry: r.industry ?? null,
    }));
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Slug candidate generation
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/**
 * Sparrow's database has scraping artifacts — entries whose "name" is a job
 * title, a forum post excerpt, equals-sign decoration, etc. Drop the obvious
 * junk so we don't waste probes on them.
 */
function isLikelyJunkName(name: string): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 80) return true;
  // Decoration/separator characters or markdown headers
  if (/^[=#*_-]+/.test(trimmed)) return true;
  // Job-title hints
  if (/\[remote\]/i.test(trimmed)) return true;
  // Markdown links or HTML
  if (/\[https?:\/\//i.test(trimmed) || /<[a-z]/i.test(trimmed)) return true;
  // Forum-post artifacts ("N point by user N days ago")
  if (/\d+\s+point\s+by\s+/i.test(trimmed)) return true;
  // Must have at least 2 alphabetic chars
  const alphaChars = (trimmed.match(/[a-z]/gi) ?? []).length;
  if (alphaChars < 2) return true;
  return false;
}

function generateSlugCandidates(name: string, domain: string): string[] {
  const set = new Set<string>();

  // Domain-derived (most reliable): "anthropic.com" → "anthropic"
  if (domain) {
    const base = domain.toLowerCase().replace(/^www\./, '').split('.')[0];
    if (base) set.add(slugify(base));
  }

  // Name-derived: lowercase, no spaces; with dashes; first word
  if (name) {
    const cleanName = name.toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\b(inc|llc|corp|co|ltd|limited|labs|ai)\b/gi, '')
      .trim();
    const compact = cleanName.replace(/\s+/g, '');
    const dashed = cleanName.replace(/\s+/g, '-');
    const firstWord = cleanName.split(/\s+/)[0] || '';
    set.add(slugify(compact));
    set.add(slugify(dashed));
    if (firstWord) set.add(slugify(firstWord));
  }

  // Min length 3 — anything shorter is too generic and produces false positives
  // (e.g., "apply", "14", "247" — all real SmartRecruiters accounts unrelated
  // to the company we were searching for).
  return Array.from(set).filter(s => s.length >= 3 && s.length <= 60);
}

// ---------------------------------------------------------------------------
// ATS verification — try each slug × each ATS, first match wins
// ---------------------------------------------------------------------------

async function probeGreenhouse(slug: string): Promise<boolean> {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
    const res = await axios.get(url, { timeout: VERIFY_TIMEOUT_MS, validateStatus: () => true });
    return res.status === 200 && Array.isArray(res.data?.jobs) && res.data.jobs.length > 0;
  } catch { return false; }
}

async function probeLever(slug: string): Promise<boolean> {
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const res = await axios.get(url, { timeout: VERIFY_TIMEOUT_MS, validateStatus: () => true });
    return res.status === 200 && Array.isArray(res.data) && res.data.length > 0;
  } catch { return false; }
}

async function probeAshby(slug: string): Promise<boolean> {
  try {
    const url = `https://jobs.ashbyhq.com/${slug}`;
    const res = await axios.get<string>(url, {
      timeout: VERIFY_TIMEOUT_MS,
      validateStatus: () => true,
      responseType: 'text',
    });
    if (res.status !== 200 || typeof res.data !== 'string') return false;
    const m = res.data.match(/window\.__appData\s*=\s*(\{.*?\});\s*\n/s);
    if (!m) return false;
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed?.jobBoard?.jobPostings) && parsed.jobBoard.jobPostings.length > 0;
  } catch { return false; }
}

async function probeSmartRecruiters(slug: string): Promise<boolean> {
  try {
    const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`;
    const res = await axios.get(url, { timeout: VERIFY_TIMEOUT_MS, validateStatus: () => true });
    // SmartRecruiters returns 200 + empty content for non-existent slugs, so
    // require at least one posting to confirm the company actually exists.
    return res.status === 200
      && Array.isArray(res.data?.content)
      && res.data.content.length > 0;
  } catch { return false; }
}

async function probe(slug: string, ats: ATS): Promise<boolean> {
  switch (ats) {
    case 'greenhouse': return probeGreenhouse(slug);
    case 'lever': return probeLever(slug);
    case 'ashby': return probeAshby(slug);
    case 'smartrecruiters': return probeSmartRecruiters(slug);
  }
}

/**
 * Try each ATS × slug combination. Returns the first hit (slug + ats) or null.
 * Strategy: iterate ATSs as outer loop (so we exhaust slug variants per-ATS
 * before moving on) — first-ATS-with-any-hit wins, which empirically biases
 * toward the most common ATSs first.
 */
async function findATSMatch(
  candidates: string[],
  existingKeys: Set<string>,
): Promise<{ slug: string; ats: ATS } | null> {
  for (const ats of ATS_LIST) {
    for (const slug of candidates) {
      if (existingKeys.has(`${ats}:${slug}`)) {
        // Already in ats-targets — counts as a "match" but no new entry to add.
        return null;
      }
      const ok = await probe(slug, ats);
      if (ok) return { slug, ats };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const hiringOnly = args.includes('--hiring-only');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

  console.log(`[match-sparrow] Connecting to Sparrow's Postgres...`);
  const companies = await fetchSparrowCompanies(hiringOnly, limit);
  console.log(`[match-sparrow] Loaded ${companies.length} companies${hiringOnly ? ' (hiring-only)' : ''}`);

  const config = JSON.parse(fs.readFileSync(ATS_TARGETS_PATH, 'utf-8')) as { targets: ATSTarget[] };
  const existing = new Set<string>(
    config.targets.map(t => `${t.ats}:${t.slug.toLowerCase()}`),
  );
  console.log(`[match-sparrow] ${config.targets.length} existing ATS targets in tracker\n`);

  const queue = [...companies];
  const newTargets: ATSTarget[] = [];
  let hitsAlreadyKnown = 0;
  let processed = 0;

  let skippedJunk = 0;
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const company = queue.shift();
      if (!company) return;
      processed++;
      if (processed % 100 === 0) {
        console.log(`  [progress] ${processed}/${companies.length} · ${newTargets.length} new · ${hitsAlreadyKnown} dupes · ${skippedJunk} junk`);
      }

      if (isLikelyJunkName(company.name)) { skippedJunk++; continue; }
      const candidates = generateSlugCandidates(company.name, company.domain);
      if (candidates.length === 0) continue;

      // Quick dedup pre-check: if every (ats, candidate) combo is already in
      // existing, skip the probe entirely — common case.
      const allKnown = ATS_LIST.every(ats =>
        candidates.every(s => existing.has(`${ats}:${s}`)),
      );
      if (allKnown) { hitsAlreadyKnown++; continue; }

      const match = await findATSMatch(candidates, existing);
      if (match) {
        const key = `${match.ats}:${match.slug}`;
        if (existing.has(key)) {
          hitsAlreadyKnown++;
          continue;
        }
        existing.add(key);
        newTargets.push({
          slug: match.slug,
          ats: match.ats,
          name: company.name,
          source: 'sparrow',
        });
        console.log(`  ✓ ${company.name} → ${match.ats}/${match.slug}`);
      }
    }
  }

  const workers = Array.from({ length: WORKER_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log(`\n[match-sparrow] Summary:`);
  console.log(`  Companies processed: ${processed}`);
  console.log(`  Junk names skipped: ${skippedJunk}`);
  console.log(`  New ATS targets: ${newTargets.length}`);
  console.log(`  Already-known matches: ${hitsAlreadyKnown}`);
  const real = processed - skippedJunk;
  console.log(`  Miss rate (excl. junk): ${(((real - newTargets.length - hitsAlreadyKnown) / Math.max(1, real)) * 100).toFixed(1)}%`);

  // Per-ATS breakdown
  const byATS: Record<string, number> = {};
  for (const t of newTargets) byATS[t.ats] = (byATS[t.ats] ?? 0) + 1;
  console.log(`  By ATS:`, byATS);

  if (newTargets.length === 0) {
    console.log('\nNothing to add.');
    return;
  }

  if (dryRun) {
    console.log(`\n--- dry run; not writing. First 30 new targets: ---`);
    for (const t of newTargets.slice(0, 30)) {
      console.log(`  ${t.ats}/${t.slug}  (${t.name})`);
    }
    return;
  }

  config.targets.push(...newTargets);
  fs.writeFileSync(ATS_TARGETS_PATH, JSON.stringify(config, null, 2));
  console.log(`\n✓ Wrote ${newTargets.length} new targets to ${ATS_TARGETS_PATH}`);
}

main().catch(err => {
  console.error('[match-sparrow] Fatal:', err);
  process.exit(1);
});
