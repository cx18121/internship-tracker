import { firefox, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Internship } from '../../lib/types';
import { discoverATSTarget, saveDiscoveredTargets } from '../../lib/utils/ats-discovery';
import { buildInternshipRow } from '../utils/build-row';
import { HANDSHAKE_PROMO_BANNER_SOURCE } from '../utils/description-trim';
import { pool } from '../../lib/concurrency';
import { deriveCompany, deriveRoleAndComp, deriveLocation } from './handshake-parse';
import { parseSalary } from '../../lib/salary';

function alertAuthExpired(): void {
  console.warn('[handshake] Session expired — re-run: npx tsx src/handshake-login.ts');
}

const AUTH_PATH = path.join(process.cwd(), 'data', 'handshake-auth.json');

const JOBS_URL =
  'https://app.joinhandshake.com/job-search?page=1&per_page=25&sort_direction=desc&sort_column=created_at&employment_type[]=Internship';

async function scrapeJobsPage(context: BrowserContext): Promise<Partial<Internship>[]> {
  const results: Partial<Internship>[] = [];
  const page = await context.newPage();

  try {
    // Navigate to a landing page first so the SPA initializes, then go to job search
    await page.goto('https://app.joinhandshake.com/stu/jobs', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Check we're logged in (not redirected to login)
    if (page.url().includes('login') || page.url().includes('sign_in')) {
      console.warn('[handshake poller] Session expired — run: npx tsx src/handshake-login.ts');
      alertAuthExpired();
      await page.close();
      return [];
    }

    // Now navigate to the filtered job search URL
    await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for job cards — selector matches "job-result-card | {id}"
    // Use a generous timeout; silently continue if cards don't appear (will evaluate 0)
    await page.waitForSelector('[data-hook^="job-result-card"]', { timeout: 20000 }).catch(() => {
      console.warn('[handshake poller] waitForSelector timed out on page 1 — no cards found');
    });
    await page.waitForTimeout(1000);

    let pageNum = 1;
    const MAX_PAGES = 20;

    while (pageNum <= MAX_PAGES) {
      const rawCards = await page.evaluate(() => {
        const cards = document.querySelectorAll('[data-hook^="job-result-card"]:not([data-hook*="footer"]):not([data-hook*="hide"])');
        return Array.from(cards).map((card) => {
          const hook = card.getAttribute('data-hook') || '';
          const jobId = hook.split('|')[1]?.trim() || '';
          const anchor = card.querySelector('a[aria-label]');
          const ariaLabel = (anchor?.getAttribute('aria-label') || '').replace(/^View\s+/i, '').replace(/^Loading\.*\s*/i, '').trim();
          const href = anchor?.getAttribute('href') || '';
          const link = href
            ? `https://app.joinhandshake.com${href.split('?')[0]}`
            : jobId ? `https://app.joinhandshake.com/job-search/${jobId}` : '';
          const logoAlt = (card.querySelector('img[alt]') as HTMLImageElement | null)?.alt?.trim() || '';
          const footerEl = card.querySelector('[data-hook="job-result-card-footer"]');
          const footerText = (footerEl?.textContent || '').replace(/\s+/g, ' ').trim();
          return { jobId, ariaLabel, link, logoAlt, footerText };
        }).filter((c) => c.jobId && c.ariaLabel);
      });

      const now = new Date().toISOString();
      let needCompanyBackfill = 0;
      for (const raw of rawCards) {
        const company = deriveCompany(raw.logoAlt, raw.ariaLabel);
        // Location first — deriveRoleAndComp uses it to chop the tail on cards
        // that render with no pay/separator boundary.
        const location = deriveLocation(raw.footerText);
        const { role, comp } = deriveRoleAndComp(company ?? '', raw.ariaLabel, location);
        if (!role) continue; // nothing usable
        const sal = comp ? parseSalary(comp) : { text: null, min: null, max: null, unit: null };
        const row = buildInternshipRow({
          title: role,
          company: company ?? '',
          location,
          link: raw.link,
          source: 'Handshake',
          seenAt: now,
        });
        if (sal.text) {
          row.salaryText = sal.text;
          row.salaryMin = sal.min ?? undefined;
          row.salaryMax = sal.max ?? undefined;
          row.salaryUnit = sal.unit ?? undefined;
        }
        if (!company) needCompanyBackfill++;
        // Carry jobId so the detail-page pass can backfill company by id.
        (row as Partial<Internship> & { _jobId?: string })._jobId = raw.jobId;
        results.push(row);
      }
      console.log(`[handshake poller] Page ${pageNum}: ${rawCards.length} cards (${needCompanyBackfill} need company backfill)`);

      // Paginate — update URL query param
      pageNum++;
      const nextUrl = `https://app.joinhandshake.com/job-search?page=${pageNum}&per_page=25&sort_direction=desc&sort_column=created_at&employment_type[]=Internship`;
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForSelector('[data-hook^="job-result-card"]', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // Stop if no cards on this page
      const cardCount = await page.evaluate(() =>
        document.querySelectorAll('[data-hook^="job-result-card"]:not([data-hook*="footer"]):not([data-hook*="hide"])').length
      );
      if (cardCount === 0) break;

      if (pageNum > MAX_PAGES) {
        console.warn(`[handshake poller] Hit MAX_PAGES (${MAX_PAGES}) — results may be incomplete`);
      }
    }
  } catch (err: any) {
    console.warn(`[handshake poller] Scrape error: ${err.message}`);
  }

  await page.close();
  return results;
}

const EXTERNAL_ATS_PATTERNS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'icims.com',
  'smartrecruiters.com', 'workday.com', 'taleo.net', 'successfactors', 'ats.rippling.com',
  'apply.workable.com',
];

/**
 * Visit each job's detail page and replace the Handshake link with a direct ATS link
 * when one is found. Mutates the job objects in-place.
 */
async function enrichWithDetailLinks(
  context: BrowserContext,
  jobs: Partial<Internship>[],
  limit = 100,
  concurrency = 3,
): Promise<void> {
  const batch = jobs.slice(0, limit);
  let enriched = 0;
  let descFound = 0;
  let descMissed = 0;

  await pool(batch, concurrency, async (job) => {
    if (!job.link) return;
    const page = await context.newPage();
    try {
      // Card anchors point to /job-search/{id}, which renders the listing
      // SPA with a small sidebar — no <data-hook="job-details-page">
      // wrapper, no real description text. The dedicated detail view at
      // /jobs/{id} has both. Verified via probe on 2026-05-22.
      const detailUrl = job.link.replace(/\/job-search\/(\d+)/, '/jobs/$1');
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Detail page is a React SPA; the description block is injected via
      // an XHR that takes ~2-3s to settle.
      await page.waitForTimeout(3000);

      const detail = await page.evaluate(({ patterns, bannerSource }: { patterns: string[]; bannerSource: string }) => {
        const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];

        // Priority 1: any link directly matching a known ATS platform
        let externalLink: string | null = null;
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          if (patterns.some(p => href.includes(p))) { externalLink = href; break; }
        }

        // Priority 2: an "Apply" anchor that points outside joinhandshake.com
        if (!externalLink) {
          for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (!href.startsWith('http')) continue;
            if (href.includes('joinhandshake.com')) continue;
            const text = (a.textContent || '').trim().toLowerCase();
            const aria = (a.getAttribute('aria-label') || '').toLowerCase();
            if (text.includes('apply') || aria.includes('apply')) { externalLink = href; break; }
          }
        }

        // Description: scope to [data-hook="job-details-page"] (the wrapper
        // present only on the dedicated detail view), strip known noise
        // subsections, and take the remaining text. The detail-root is
        // bounded to job-specific content — no site nav/footer to pollute
        // the way the old `body p` fallback did, so this is safe.
        //
        // Tried two narrower strategies first (Description: prefix; longest
        // single <p>) — both missed on 3/5 sample postings because
        // Handshake's detail layout varies: some employers get rendered
        // with a "Description:" header, others get raw <p> tags, others
        // split job-body across non-<p> divs.
        let description = '';
        let descSelectorHit = '';
        const detailRoot = document.querySelector('[data-hook="job-details-page"]') as HTMLElement | null;
        if (detailRoot) {
          // Clone so we can prune subtrees without mutating the live DOM.
          const clone = detailRoot.cloneNode(true) as HTMLElement;
          // Apply-modal content is a form ("Attach your resume…"); not the
          // posting body. Remove it before extracting text.
          clone.querySelectorAll('[data-hook="apply-modal-content"]').forEach(el => el.remove());
          // Similar-jobs sidebar — each entry has its own job-hide-button
          // hook. Removing them removes the entire "more jobs like this"
          // list while keeping the description proper.
          clone.querySelectorAll('[data-hook^="job-hide-button-"]').forEach(el => {
            // Walk up to the nearest card container and remove it.
            let target: HTMLElement | null = el as HTMLElement;
            for (let i = 0; i < 6 && target; i++) {
              if (target.parentElement?.children && target.parentElement.children.length > 1) break;
              target = target.parentElement;
            }
            (target ?? el).remove();
          });
          const text = (clone.textContent || '').trim();
          if (text.length > 100) {
            description = text;
            descSelectorHit = 'job-details-page (apply-modal + similar-jobs stripped)';
          }
        }
        description = description.replace(/\s+/g, ' ').trim();
        // Handshake's mobile-app promo banner sits inside the same data-hook
        // wrapper and gets captured as a description prefix. Word-for-word
        // stable across postings; strip it. Banner pattern is shared with
        // the backfill script via HANDSHAKE_PROMO_BANNER_SOURCE. If nothing
        // of substance is left after the strip, return empty rather than
        // store the banner.
        description = description.replace(new RegExp(bannerSource, 'gi'), '').trim();
        if (description.length < 50) description = '';
        // Memory floor; smartTrimDescription in agent.ts caps for storage.
        description = description.slice(0, 20_000);

        // Employer name fallback for logoless cards: the detail page's
        // employer logo alt is "{Company} logo" (recon 2026-06-04). Strip the
        // trailing " logo". Scoped to the details root to avoid similar-jobs.
        let employerName = '';
        const detailImg = (document.querySelector('[data-hook="job-details-page"] img[alt]') as HTMLImageElement | null);
        if (detailImg?.alt) employerName = detailImg.alt.replace(/\s*logo\s*$/i, '').trim();

        return { externalLink, description, descSelectorHit, employerName };
      }, { patterns: EXTERNAL_ATS_PATTERNS, bannerSource: HANDSHAKE_PROMO_BANNER_SOURCE });

      if (detail.externalLink) {
        job.link = detail.externalLink;
        enriched++;
      }
      if (detail.description) {
        job.description = detail.description;
        descFound++;
      } else {
        descMissed++;
      }
      if (!job.company && detail.employerName) {
        job.company = detail.employerName;
      }
    } catch {
      // Keep original Handshake URL on error
    } finally {
      await page.close();
    }
  });

  console.log(`[handshake poller] Detail enrichment: ${enriched}/${batch.length} jobs got direct ATS links`);
  // Surface a warning if Handshake's description markup may have shifted —
  // dropping the unsafe `body p` fallback means we get less data but more
  // honestly, and this metric lets us notice if every selector starts missing.
  if (batch.length > 0 && descMissed / batch.length > 0.5) {
    console.warn(`[handshake poller] Description selectors missed for ${descMissed}/${batch.length} jobs — Handshake DOM may have changed`);
  } else if (batch.length > 0) {
    console.log(`[handshake poller] Descriptions: ${descFound}/${batch.length} populated`);
  }
}

export async function pollHandshake(): Promise<Partial<Internship>[]> {
  if (!fs.existsSync(AUTH_PATH)) {
    console.warn('[handshake poller] No saved session — run: npx tsx src/handshake-login.ts');
    return [];
  }

  let browser;
  try {
    browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({
      storageState: AUTH_PATH,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });

    // tsx transpiles named arrow functions with a __name() helper that doesn't
    // exist in the browser context — polyfill it before any page.evaluate runs.
    await context.addInitScript(() => {
      // @ts-expect-error injecting helper into browser global
      globalThis.__name = (fn: unknown) => fn;
    });

    const results = await scrapeJobsPage(context);

    // Enrich top 100 jobs with direct ATS links from detail pages
    await enrichWithDetailLinks(context, results);

    await context.close();

    // Drop any row that still lacks a company (logoless card not in the
    // enriched batch, or detail-page fallback also missed) — never store
    // garbage. Strip the temp _jobId so it never reaches storage.
    const beforeDrop = results.length;
    const cleaned = results.filter((r) => (r.company || '').trim().length > 0);
    const droppedNoCompany = beforeDrop - cleaned.length;
    if (droppedNoCompany > 0) {
      console.warn(`[handshake poller] Dropped ${droppedNoCompany} card(s) with no resolvable company`);
    }
    cleaned.forEach((r) => { delete (r as Partial<Internship> & { _jobId?: string })._jobId; });

    // Auto-discover new ATS targets from extracted links
    const discovered = cleaned
      .map(job => discoverATSTarget(job.link || '', job.company || ''))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const added = saveDiscoveredTargets(discovered);
    if (added > 0) {
      console.log(`[handshake poller] Auto-discovered ${added} new ATS target(s)`);
    }

    console.log(`[handshake poller] Total: ${cleaned.length}`);
    return cleaned;
  } catch (err: any) {
    console.error(`[handshake poller] Browser error: ${err.message}`);
    return [];
  } finally {
    await browser?.close();
  }
}
