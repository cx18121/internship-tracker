import { chromium } from 'playwright';
import { Internship } from '../types.js';

const BASE_URL = 'https://www.workatastartup.com';
const POLL_TIMEOUT = 60_000;
const REQUEST_TIMEOUT = 20_000;

interface RawJob {
  id: number;
  title: string;
  jobType: 'intern' | 'fulltime' | 'parttime' | 'contract';
  location: string;
  roleType: string;
  companyName: string;
  companySlug: string;
  companyBatch: string;
  companyOneLiner: string;
  companyLogoUrl: string | null;
  companyLastActiveAt: string | null;
  applyUrl: string;
}

/**
 * YC Work at a Startup embeds full job data as JSON in a <div data-page="...">
 * SSR attribute. This function uses Playwright to navigate and extract the
 * embedded JSON (faster than scraping DOM elements since no selectors needed).
 */
async function fetchViaPlaywright(now: string): Promise<Partial<Internship>[]> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${BASE_URL}/jobs?jobType=intern`, {
      waitUntil: 'networkidle',
      timeout: POLL_TIMEOUT,
    });

    const internships = await page.evaluate((nowStr: string) => {
      const div = document.querySelector('[data-page]');
      if (!div) return [];
      const raw = div.getAttribute('data-page') || '';
      const decoded = raw
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
      let data: any;
      try {
        data = JSON.parse(decoded);
      } catch {
        return [];
      }
      const jobs: RawJob[] = data?.props?.jobs || [];
      return jobs
        .filter((j) => j.jobType === 'intern')
        .map((j) => ({
          title: j.title,
          company: j.companyName,
          location: j.location ?? null,
          link: `https://www.workatastartup.com/jobs/${j.id}`,
          source: 'YC WaaS',
          postedAt: j.companyLastActiveAt || nowStr,
          seenAt: nowStr,
          applied: false,
        }));
    }, now);

    return internships;
  } finally {
    await browser.close();
  }
}

/**
 * Fallback: direct HTTP fetch + JSON extraction without Playwright.
 * Works for the SSR-rendered initial batch (~30 jobs).
 */
async function fetchViaSSR(now: string): Promise<Partial<Internship>[]> {
  const { default: axios } = await import('axios');
  const { data: html } = await axios.get(`${BASE_URL}/jobs`, {
    timeout: REQUEST_TIMEOUT,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    responseType: 'text',
  });

  const match = /data-page="([\s\S]*?)"/.exec(html);
  if (!match) return [];

  const raw = match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const jobs: RawJob[] = data?.props?.jobs || [];
  return jobs
    .filter((j) => j.jobType === 'intern')
    .map((j) => ({
      title: j.title,
      company: j.companyName,
      location: j.location ?? null,
      link: `https://www.workatastartup.com/jobs/${j.id}`,
      source: 'YC WaaS',
      postedAt: j.companyLastActiveAt || now,
      seenAt: now,
      applied: false,
    }));
}

export async function pollYCWaaS(): Promise<Partial<Internship>[]> {
  const now = new Date().toISOString();
  let jobs: Partial<Internship>[] = [];

  // Primary: Playwright extracts SSR data via page.evaluate (fast, no selector brittle-ness)
  try {
    jobs = await fetchViaPlaywright(now);
    if (jobs.length > 0) {
      console.log(`[yc-waas] Playwright: ${jobs.length} internships`);
    }
  } catch (e: any) {
    console.warn(`[yc-waas] Playwright failed (${e.message}), falling back to SSR`);
    try {
      jobs = await fetchViaSSR(now);
      if (jobs.length > 0) {
        console.log(`[yc-waas] SSR fallback: ${jobs.length} internships`);
      }
    } catch (e2: any) {
      console.warn(`[yc-waas] SSR fallback also failed: ${e2.message}`);
    }
  }

  // Deduplicate by title+company
  const seen = new Set<string>();
  const deduped = jobs.filter((j) => {
    const key = `${j.title}::${j.company}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length < jobs.length) {
    console.log(`[yc-waas] Deduped ${jobs.length} → ${deduped.length}`);
  }

  console.log(`[yc-waas] Total: ${deduped.length} internships`);
  return deduped;
}
