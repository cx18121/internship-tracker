// follow-simplify-links-browser.ts
// Resolves simplify.jobs listing URLs to their actual ATS apply links.
//
// Flow for each simplify.jobs entry:
//   1. Navigate to https://simplify.jobs/p/<uuid>  (page has job data in __NEXT_DATA__)
//   2. Extract jobPosting.url from __NEXT_DATA__ → https://simplify.jobs/jobs/click/<uuid>
//   3. Fire a HEAD/GET at that click URL to follow the 307 redirect
//   4. Pass the resolved ATS URL to discoverATSTarget()
//
// This avoids Cloudflare 403 because:
// - Step 1 hits a normal HTML page (Cloudflare doesn't block the listing page)
// - Step 3 follows the server-side redirect to the ATS (no Cloudflare involved)
//
// Usage: npx tsx src/follow-simplify-links-browser.ts

import { firefox } from 'playwright';
import axios from 'axios';
import * as path from 'path';
import { discoverATSTarget, saveDiscoveredTargets } from './utils/ats-discovery.js';

const DB_PATH = path.join(process.cwd(), 'data', 'internships.db');
const TIMEOUT = 20_000;
const CONCURRENCY = 5;

interface SimplifyJobEntry {
  id: string;
  company: string;
  link: string;   // original simplify.jobs URL
  atsSource: string | null;
}

interface ResolvedJob {
  company: string;
  originalLink: string;
  clickUrl: string | null;   // from __NEXT_DATA__ jobPosting.url
  finalUrl: string | null;   // after following click URL redirect
  ats: string | null;
}

// ── Step 1: get the click-through URL from the simplify.jobs listing page ─────
async function getClickUrl(page: any, listingUrl: string): Promise<string | null> {
  try {
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    // The __NEXT_DATA__ is in the initial HTML — no JS wait needed
    const clickUrl: string | undefined = await page.evaluate(() => {
      try {
        return (window as any).__NEXT_DATA__?.props?.pageProps?.jobPosting?.url ?? null;
      } catch { return null; }
    });
    return clickUrl ?? null;
  } catch (_e) {
    return null;
  }
}

// ── Step 2: follow the click URL to get the actual ATS URL ────────────────────
async function resolveClickUrl(clickUrl: string): Promise<string | null> {
  try {
    const resp = await axios.get(clickUrl, {
      timeout: 15_000,
      maxRedirects: 0,   // manual redirect handling
      validateStatus: s => s === 307 || s < 400,
    });
    const location = resp.headers['location'] as string | undefined;
    return location ?? null;
  } catch (_e) {
    return null;
  }
}

// ── Concurrency helper ─────────────────────────────────────────────────────────
async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Math.min(concurrency, queue.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()!;
        await fn(item);
      }
    }),
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);

  const rows: SimplifyJobEntry[] = db
    .prepare("SELECT id, company, link, ats_source as atsSource FROM internships WHERE link LIKE '%simplify.jobs%'")
    .all();

  if (rows.length === 0) {
    console.log('[follow-simplify] No simplify.jobs entries found.');
    db.close();
    return;
  }

  // Filter out entries that already have a real ATS source (not simplify.jobs)
  const unresolved = rows.filter(r => !r.atsSource || r.atsSource === 'SimplifyJobs');
  console.log(`[follow-simplify] ${rows.length} total simplify.jobs entries (${unresolved.length} need resolution)`);

  const browser = await firefox.launch({ headless: true });

  const resolved: ResolvedJob[] = [];
  const failed: string[] = [];

  await withConcurrency(unresolved, CONCURRENCY, async (entry) => {
    const page = await browser.newPage();
    let clickUrl: string | null = null;
    let finalUrl: string | null = null;
    let ats: string | null = null;

    try {
      // Step 1: get the click URL from the listing page
      clickUrl = await getClickUrl(page, entry.link);
      if (!clickUrl) {
        failed.push(entry.company);
        return;
      }

      // Step 2: resolve the click URL to the real ATS
      finalUrl = await resolveClickUrl(clickUrl);
      if (!finalUrl) {
        failed.push(entry.company);
        return;
      }

      ats = discoverATSTarget(finalUrl, entry.company)?.ats ?? null;
      resolved.push({ company: entry.company, originalLink: entry.link, clickUrl, finalUrl, ats });

      console.log(`[follow-simplify] OK  ${entry.company}: ${finalUrl} (${ats ?? 'unmatched'})`);

    } catch (_e) {
      failed.push(entry.company);
    } finally {
      await page.close();
    }
  });

  await browser.close();
  db.close();

  // Save discovered ATS targets
  const targets = resolved
    .map(r => r.finalUrl ? discoverATSTarget(r.finalUrl, r.company) : null)
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const added = saveDiscoveredTargets(targets);

  console.log(`\n[follow-simplify] Done.`);
  console.log(`  Resolved: ${resolved.length}  |  Failed: ${failed.length}  |  New ATS targets: ${added}`);
  if (failed.length > 0) {
    console.log(`  Failed companies: ${failed.slice(0, 10).join(', ')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
