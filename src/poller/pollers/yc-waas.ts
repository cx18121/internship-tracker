// Firefox (not Chromium) so the Docker image only needs one browser binary —
// see [[feedback-handshake-firefox]]: Handshake auth requires Firefox and
// can't be swapped, so we standardize the other pollers on Firefox too.
// YC WaaS has no bot-detection concerns; the choice is purely about image size.
import { firefox } from 'playwright';
import { Internship } from '../../lib/types';
import { buildInternshipRow } from '../utils/build-row';

const BASE_URL = 'https://www.workatastartup.com';
const POLL_TIMEOUT = 60_000;
const REQUEST_TIMEOUT = 20_000;

// YC's /jobs SSR exposes only ~30 jobs per page and the page does no infinite
// scroll — so the unfiltered endpoint typically yields 0-3 interns. The
// per-role pages (/jobs/l/<slug>) each return their own ~25-job slice; the
// union across roles surfaces ~5x more intern listings.
const ROLE_PATHS = [
  '/jobs/l/software-engineer',
  '/jobs/l/designer',
  '/jobs/l/science',
  '/jobs/l/product-manager',
  '/jobs/l/operations',
  '/jobs/l/sales-manager',
  '/jobs/l/marketing',
  '/jobs/l/legal',
  '/jobs/l/finance',
  '/jobs/l/recruiting',
];

function buildSeedDescription(j: RawJob): string | undefined {
  // Listing pages don't include a real job description (the detail page does),
  // but they do include the company one-liner and a parseable salary string.
  // Stitch them into a placeholder so parseSalary in agent.ts can pick salary up.
  const parts = [
    j.salary ? `Salary: ${j.salary}` : '',
    j.companyOneLiner || '',
  ].filter(Boolean);
  return parts.length ? parts.join('. ') : undefined;
}

function extractInterns(rawHtmlAttr: string, now: string): Partial<Internship>[] {
  const decoded = rawHtmlAttr
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  let data: any;
  try { data = JSON.parse(decoded); } catch { return []; }
  const jobs: RawJob[] = data?.props?.jobs || [];
  return jobs
    .filter((j) => (j.jobType || '').toLowerCase() === 'intern')
    .map((j) => buildInternshipRow({
      title: j.title,
      company: j.companyName,
      location: j.location,
      link: `https://www.workatastartup.com/jobs/${j.id}`,
      source: 'YC WaaS',
      upstreamPostedAt: j.companyLastActiveAt,
      seenAt: now,
      description: buildSeedDescription(j),
    }));
}

/**
 * Fetch the real job description from a detail page. Detail pages expose
 * props.job.descriptionHtml (~3-4kb of HTML). Returns the existing seed
 * description (oneLiner + salary) prepended so the salary stays parseable
 * by downstream agent.ts parseSalary.
 */
async function enrichDescription(
  page: import('playwright').Page,
  jobs: Partial<Internship>[],
): Promise<void> {
  for (const j of jobs) {
    if (!j.link) continue;
    try {
      await page.goto(j.link, { waitUntil: 'networkidle', timeout: POLL_TIMEOUT });
      const html = await page.evaluate(() => {
        const div = document.querySelector('[data-page]');
        return div?.getAttribute('data-page') || '';
      });
      const decoded = html
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      let data: any;
      try { data = JSON.parse(decoded); } catch { continue; }
      const rawHtml = data?.props?.job?.descriptionHtml || '';
      if (!rawHtml) continue;
      const plain = rawHtml
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!plain) continue;
      // Keep the seed (which carries the salary string) so parseSalary still works,
      // then append the real description body. smartTrimDescription in agent.ts
      // applies the storage cap; this 20000 is a memory floor.
      j.description = [j.description, plain].filter(Boolean).join('\n\n').slice(0, 20_000);
    } catch {
      // Detail-page fetches are best-effort; failures leave the seed description alone.
    }
  }
}

interface RawJob {
  id: number;
  title: string;
  // YC's actual values are capitalized: 'Intern' | 'Fulltime' | 'Parttime' | 'Contract'.
  // Compare case-insensitively below — lowercased typedef in earlier code was wrong
  // and silently filtered every intern out.
  jobType: string;
  location: string;
  roleType: string;
  companyName: string;
  companySlug: string;
  companyBatch: string;
  companyOneLiner: string;
  companyLogoUrl: string | null;
  companyLastActiveAt: string | null;
  applyUrl: string;
  // Listing-level salary range string, e.g. "$200K - $250K" or "$124K - $188K CAD".
  // Parsed downstream by agent.ts via parseSalary on title + description.
  salary?: string;
}

/**
 * YC Work at a Startup embeds full job data as JSON in a <div data-page="...">
 * SSR attribute. We iterate per-role URLs because each one returns its own
 * ~25-job slice (the unfiltered /jobs page surfaces 0-3 interns; per-role
 * coverage roughly 5x's that).
 */
async function fetchViaPlaywright(now: string): Promise<Partial<Internship>[]> {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  const found = new Map<string, Partial<Internship>>();

  try {
    for (const path of ROLE_PATHS) {
      try {
        await page.goto(`${BASE_URL}${path}`, {
          waitUntil: 'networkidle',
          timeout: POLL_TIMEOUT,
        });
        const rawAttr = await page.evaluate(() => {
          const div = document.querySelector('[data-page]');
          return div?.getAttribute('data-page') || '';
        });
        const interns = extractInterns(rawAttr, now);
        for (const j of interns) {
          if (j.link) found.set(j.link, j);
        }
      } catch (e: any) {
        console.warn(`[yc-waas] role ${path} failed: ${e.message}`);
      }
    }
    const collected = Array.from(found.values());
    await enrichDescription(page, collected);
    return collected;
  } finally {
    await browser.close();
  }
}

/**
 * Fallback: direct HTTP fetch + JSON extraction without Playwright.
 * Iterates the same per-role URLs.
 */
async function fetchViaSSR(now: string): Promise<Partial<Internship>[]> {
  const { default: axios } = await import('axios');
  const found = new Map<string, Partial<Internship>>();
  for (const path of ROLE_PATHS) {
    try {
      const { data: html } = await axios.get<string>(`${BASE_URL}${path}`, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'text',
      });
      const match = /data-page="([\s\S]*?)"/.exec(html);
      if (!match) {
        console.warn(`[yc-waas] SSR role ${path}: data-page attribute not found — markup may have changed`);
        continue;
      }
      const interns = extractInterns(match[1], now);
      if (interns.length === 0) {
        // Either the regex captured the wrong slice (e.g. truncated at an
        // embedded quote inside the attribute) or the page genuinely had
        // zero intern roles. Warn so we see this in logs.
        console.warn(`[yc-waas] SSR role ${path}: extracted 0 intern roles from data-page`);
      }
      for (const j of interns) {
        if (j.link) found.set(j.link, j);
      }
    } catch (e: any) {
      console.warn(`[yc-waas] SSR role ${path} failed: ${e.message}`);
    }
  }
  return Array.from(found.values());
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
