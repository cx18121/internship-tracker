/**
 * Playwright-based careers page scanner.
 *
 * Navigates directly to company careers pages (not on known ATS platforms)
 * using browser automation to extract job listings from JavaScript-rendered pages.
 *
 * This is Level 1 of the scan system: direct URL navigation for companies
 * that have a careers_url in data/companies.yml but no known ATS platform
 * (Greenhouse/Lever/Ashby slug).
 *
 * Rate limit: max 2 companies/minute to avoid 429s from target servers.
 */

import { firefox, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
// @ts-ignore
import * as yaml from 'js-yaml';
import { Internship } from '../../lib/types';

// ── Paths ──────────────────────────────────────────────────────────────────

const COMPANIES_PATH = path.join(process.cwd(), 'data', 'companies.yml');
const SCAN_HISTORY_PATH = path.join(process.cwd(), 'data', 'scan-history.json');
const ARCHIVE_PATH = path.join(process.cwd(), 'data', 'companies-archived.yml');

// ── Types ───────────────────────────────────────────────────────────────────

interface Company {
  name: string;
  website?: string;
  greenhouse_slug: string | null;
  lever_slug: string | null;
  ashby_slug: string | null;
  careers_url: string | null;
  tier?: string;
}

interface CompaniesData {
  companies: Company[];
}

interface ScanHistory {
  archivedCompanies: Record<string, string>; // name → archivedAt reason
  lastScanAt?: string;
}

// ── Browser pool (same pattern as playwright-fill.ts) ─────────────────────

interface BrowserPool {
  browser: Browser;
  maxAge: number;
}

let _pool: BrowserPool | null = null;
const POOL_MAX_AGE_MS = 5 * 60 * 1000;

async function acquireBrowser(): Promise<Browser> {
  const now = Date.now();
  if (_pool && _pool && now - _pool.maxAge < POOL_MAX_AGE_MS) {
    _pool.maxAge = now;
    return _pool.browser;
  }
  if (_pool) {
    await _pool.browser.close().catch(() => {});
    _pool = null;
  }
  const browser = await firefox.launch({
    headless: true,
    args: ['-no-sandbox', '-disable-setuid-sandbox'],
  });
  _pool = { browser, maxAge: now };
  return browser;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadCompanies(): Company[] {
  try {
    const raw = fs.readFileSync(COMPANIES_PATH, 'utf-8');
    const data: CompaniesData = yaml.load(raw) as CompaniesData;
    return data.companies ?? [];
  } catch {
    return [];
  }
}

function loadScanHistory(): ScanHistory {
  try {
    return JSON.parse(fs.readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
  } catch {
    return { archivedCompanies: {} };
  }
}

function saveScanHistory(history: ScanHistory): void {
  fs.writeFileSync(SCAN_HISTORY_PATH, JSON.stringify(history, null, 2));
  // Also append to archive file
  const archived = Object.entries(history.archivedCompanies);
  if (archived.length > 0) {
    const lines = archived.map(([name, reason]) => `# ${reason}\n- name: ${name}\n  archivedAt: ${new Date().toISOString()}\n`);
    fs.appendFileSync(ARCHIVE_PATH, lines.join('\n'));
  }
}

function archiveCompany(name: string, reason: string, history: ScanHistory): void {
  history.archivedCompanies[name] = reason;
  saveScanHistory(history);
}

/**
 * Detect the job board type from URL or page content.
 * Returns the detected platform or 'custom'.
 */
async function detectBoardType(page: Page): Promise<string> {
  const url = page.url();
  const content = await page.content();

  if (url.includes('greenhouse')) return 'greenhouse';
  if (url.includes('lever.co') || content.includes('Lever')) return 'lever';
  if (url.includes('ashbyhq') || content.includes('ashby')) return 'ashby';
  if (url.includes('workday')) return 'workday';
  if (url.includes('taleo')) return 'taleo';
  if (content.includes('jobvite') || url.includes('jobvite')) return 'jobvite';
  if (content.includes('Lever')) return 'lever';
  if (content.includes('Greenhouse')) return 'greenhouse';
  if (content.includes('Ashby')) return 'ashby';

  return 'custom';
}

/**
 * Extract job listings from a generic careers page.
 * Tries common selectors for common job board patterns.
 */
async function extractJobs(
  page: Page,
  companyName: string,
  boardType: string,
): Promise<Partial<Internship>[]> {
  const now = new Date().toISOString();

  // Try board-type-specific selectors first
  if (boardType === 'greenhouse' || boardType === 'lever' || boardType === 'ashby') {
    return extractGreenhouseStyleJobs(page, companyName, now);
  }

  // Generic fallback: look for common job card/list patterns
  return extractGenericJobs(page, companyName, now);
}

/**
 * Extract jobs from Greenhouse/Lever/Ashby-style boards.
 */
async function extractGreenhouseStyleJobs(
  page: Page,
  companyName: string,
  now: string,
): Promise<Partial<Internship>[]> {
  const jobs: Partial<Internship>[] = [];

  // Try multiple common selectors for job cards
  const selectors = [
    // Greenhouse/Lever/Ashby standard
    '[data-job-id]',
    '.posting-card',
    '.job-card',
    '.opening-card',
    '[class*="job-opening"]',
    '[class*="posting"]',
    // LinkedIn-style
    '.job-card-container',
    '.jobs-search-results__list-item',
  ];

  for (const sel of selectors) {
    try {
      const elements = await page.$$(sel);
      if (elements.length > 0) {
        for (const el of elements) {
          const title = await el.$eval('a, h2, h3, [class*="title"]', el2 => el2.textContent?.trim() || '').catch(() => '');
          const link =
            await el.$eval('a[href]', a => (a as any).href).catch(() => '');
          const location =
            await el.$eval('[class*="location"]', el2 => el2.textContent?.trim() || '').catch(() => '');

          if (title && isInternTitle(title)) {
            jobs.push({
              title,
              company: companyName,
              location: location || undefined,
              link,
              source: 'CareersScan',
              atsSource: 'careers-scan',
              postedAt: now,
              seenAt: now,
              applied: false,
            });
          }
        }
        if (jobs.length > 0) break; // Got results, stop trying selectors
      }
    } catch {
      // Selector didn't work, try next
    }
  }

  return jobs;
}

/**
 * Extract jobs from a generic careers page (no known ATS).
 */
async function extractGenericJobs(
  page: Page,
  companyName: string,
  now: string,
): Promise<Partial<Internship>[]> {
  const jobs: Partial<Internship>[] = [];

  // Try to find all links that look like job listing URLs
  const links = await page.$$eval('a[href]', (anchors) =>
    anchors
      .map(a => ({ href: a.href, text: a.textContent?.trim() || '' }))
      .filter(a =>
        /jobs?|careers?|positions?|opportunities?/i.test(a.href) &&
        !/about|blog|press|news|events/i.test(a.href),
      ),
  );

  for (const link of links) {
    if (isInternTitle(link.text)) {
      jobs.push({
        title: link.text,
        company: companyName,
        link: link.href,
        source: 'CareersScan',
        atsSource: 'careers-scan',
        postedAt: now,
        seenAt: now,
        applied: false,
      });
    }
  }

  return jobs;
}

/**
 * Try to paginate through job listings.
 * Clicks "Load more", "Show more", "Next", etc.
 */
async function tryPagination(page: Page): Promise<boolean> {
  const paginationSelectors = [
    'button:has-text("Load more")',
    'button:has-text("Show more")',
    'button:has-text("View more")',
    'a:has-text("Next")',
    '[aria-label="Load more"]',
    '[data-testid="load-more"]',
    '.load-more',
    '#load-more',
  ];

  for (const sel of paginationSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForTimeout(1500); // Wait for content to load
        return true;
      }
    } catch {
      // Try next
    }
  }
  return false;
}

/**
 * Handle infinite scroll pagination.
 */
async function handleScrollPagination(page: Page): Promise<void> {
  try {
    let prevHeight = 0;
    let sameCount = 0;
    const maxScrolls = 10;

    const doc = (globalThis as any).document;
    for (let i = 0; i < maxScrolls; i++) {
      const newHeight = await page.evaluate(() => {
        const d = (globalThis as any).document;
        return d.body.scrollHeight;
      });
      if (newHeight === prevHeight) {
        sameCount++;
        if (sameCount >= 2) break;
      } else {
        sameCount = 0;
      }
      await page.evaluate(() => {
        const d = (globalThis as any).document;
        (globalThis as any).scrollTo(0, d.body.scrollHeight);
      });
      await page.waitForTimeout(1000);
      prevHeight = newHeight;
    }
  } catch {
    // Scroll pagination failed silently
  }
}

function isInternTitle(title: string): boolean {
  return /\bintern(ship)?\b/i.test(title);
}

/**
 * Scan a single company's careers page.
 * Returns all intern postings found.
 */
async function scanCompany(
  company: Company,
  page: Page,
): Promise<Partial<Internship>[]> {
  const careersUrl = company.careers_url!;
  const now = new Date().toISOString();

  try {
    const response = await page.goto(careersUrl, {
      timeout: 30_000,
      waitUntil: 'networkidle',
    });

    // Handle 404 / gone
    if (!response || response.status() === 404) {
      return []; // Will be archived by caller
    }

    // Wait for any job listings to appear
    await page.waitForTimeout(2000);

    // Detect board type
    const boardType = await detectBoardType(page);

    // If this is actually a Greenhouse/Lever/Ashby URL, skip (shouldn't happen but)
    if (boardType !== 'custom') {
      console.log(`[careers-scan] ${company.name}: detected ${boardType} URL, skipping`);
      return [];
    }

    // Try pagination
    const paginated = await tryPagination(page);
    if (paginated) {
      await handleScrollPagination(page);
    }

    // Extract jobs
    const jobs = await extractJobs(page, company.name, boardType);
    return jobs;
  } catch (err: any) {
    if (err.message?.includes('404') || err.message?.includes('net::ERR_NAME_NOT_RESOLVED')) {
      return []; // Archive
    }
    console.warn(`[careers-scan] ${company.name}: ${err.message}`);
    return [];
  }
}

/**
 * Main entry point: scan all companies with careers_url but no known ATS.
 * Rate limited to 2 companies/minute (30s between each).
 */
export async function scanCareersPages(
  concurrency = 1, // Playwright is heavy; 1 at a time
): Promise<Partial<Internship>[]> {
  const companies = loadCompanies();
  const history = loadScanHistory();

  // Filter: has careers_url, no known ATS slug, not already archived
  const targets = companies.filter(c => {
    if (!c.careers_url) return false;
    if (c.greenhouse_slug || c.lever_slug || c.ashby_slug) return false;
    if (c.name in history.archivedCompanies) return false;
    return true;
  });

  if (targets.length === 0) {
    console.log('[careers-scan] No non-ATS companies with careers_url found in registry');
    return [];
  }

  console.log(`[careers-scan] Found ${targets.length} companies to scan`);

  const browser = await acquireBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
  });
  const page = await context.newPage();

  const allJobs: Partial<Internship>[] = [];
  const seen = new Set<string>();

  for (const company of targets) {
    console.log(`[careers-scan] Scanning ${company.name} (${company.careers_url})`);
    const jobs = await scanCompany(company, page);

    if (jobs.length === 0) {
      // No jobs found — could be no interns or page dead.
      // Archive only if we can confirm 404 (handled in scanCompany).
      // Otherwise keep for next run.
      console.log(`[careers-scan] ${company.name}: no intern postings found`);
    } else {
      for (const job of jobs) {
        if (!seen.has(job.link || '')) {
          seen.add(job.link || '');
          allJobs.push(job);
        }
      }
      console.log(`[careers-scan] ${company.name}: found ${jobs.length} posting(s)`);
    }

    // Rate limit: 30s between companies (2/minute)
    if (targets.indexOf(company) < targets.length - 1) {
      await sleep(30_000);
    }
  }

  await context.close();

  // Update scan history
  history.lastScanAt = new Date().toISOString();
  saveScanHistory(history);

  console.log(`[careers-scan] Done. Total intern postings: ${allJobs.length}`);
  return allJobs;
}
