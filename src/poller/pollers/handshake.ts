import { firefox, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Internship } from '../../lib/types';
import { discoverATSTarget, saveDiscoveredTargets } from '../../lib/utils/ats-discovery';
import { buildInternshipRow } from '../utils/build-row';
import { HANDSHAKE_PROMO_BANNER_SOURCE } from '../utils/description-trim';

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
      const jobs = await page.evaluate(() => {
        const cards = document.querySelectorAll('[data-hook^="job-result-card"]:not([data-hook*="footer"]):not([data-hook*="hide"])');
        return Array.from(cards).map(card => {
          // Job ID from data-hook="job-result-card | 12345"
          const hook = card.getAttribute('data-hook') || '';
          const jobId = hook.split('|')[1]?.trim();

          // Title is in aria-label on the anchor ("View <title>")
          const anchor = card.querySelector('a[aria-label]');
          const ariaLabel = anchor?.getAttribute('aria-label') || '';
          const title = ariaLabel.replace(/^View\s+/i, '').replace(/^Loading\.*\s*/i, '').trim();

          // Link from anchor href (strip query params)
          const href = anchor?.getAttribute('href') || '';
          const link = href
            ? `https://app.joinhandshake.com${href.split('?')[0]}`
            : jobId ? `https://app.joinhandshake.com/job-search/${jobId}` : '';

          const fullText = card.textContent || '';
          const parts = fullText.split(/[·∙•|]/).map(s => s.trim()).filter(Boolean);
          // Strip "Loading..." prefixes (ASCII dots or Unicode ellipsis) from
          // lazy-loaded text content.
          const stripLoading = (s: string) => s.replace(/Loading[.\u2026\s]*/gi, '').trim();

          // Company name extraction. Verified against 25 live cards via a
          // throwaway probe (probe-handshake-card.ts, removed after this
          // commit). Tries cheap structural signals first; falls back to
          // text parsing only when both fail:
          //
          //   1. img[alt]: employer logo's alt text. Hits ~88% of cards;
          //      misses when the employer has no logo (rendered as an SVG
          //      placeholder instead).
          //   2. Title-anchored DOM walk: every card has a title element
          //      with both `id` and `aria-label="View {title}"` nested
          //      inside a `<div role="region" aria-labelledby="{uuid}">`.
          //      Within that region, the first <span> outside the title's
          //      container is the company name. Hit rate: 25/25 in probe.
          //   3. Legacy text-parts heuristic -- defensive last resort if
          //      Handshake reshuffles the DOM and breaks #2.
          let company: string | null = null;

          const logoAlt = (card.querySelector('img[alt]') as HTMLImageElement | null)?.alt?.trim() || '';
          if (logoAlt) company = stripLoading(logoAlt);

          if (!company) {
            const titleDiv = card.querySelector('[aria-label^="View " i][id]') as HTMLElement | null;
            const region = titleDiv?.closest('[role="region"]') as HTMLElement | null;
            if (titleDiv && region) {
              const titleContainer = titleDiv.parentElement;
              const spans = Array.from(region.querySelectorAll('span')) as HTMLElement[];
              for (const sp of spans) {
                if (titleContainer && titleContainer.contains(sp)) continue;
                const txt = stripLoading((sp.textContent || '').trim());
                if (txt && txt.length > 0 && txt.length <= 80) { company = txt; break; }
              }
            }
          }

          if (!company) {
            const rawCompany = stripLoading(parts[0] || '');
            const titleIdx = rawCompany.indexOf(title);
            company = titleIdx > 0
              ? rawCompany.slice(0, titleIdx).replace(/[_\s]+$/, '').trim()
              : stripLoading(parts.find(p => p !== title && p.length > 1 && p.length < 60) || '') || 'Unknown';
          }
          // Pre-strip date ranges (e.g. "May 24—Aug 9"), salary tokens, and school
          // collection labels so they don't bleed into the location match. Date ranges and
          // collection tags (e.g. "Cornell collection") concatenate directly with city names
          // (e.g. "Aug 9New York", "collectionNew York") with no space separator, so a simple
          // \b word-boundary check on the month name will fail — drop the leading \b.
          // Handshake's employment-type label "Internship" likewise glues directly onto
          // the city ("InternshipSan Jose, CA"), which the case-insensitive [a-z]+ in
          // the location regex would otherwise swallow as one proper-noun run.
          const cleanedText = fullText
            .replace(/[A-Z][a-z]{2}\s+\d{1,2}[—–\-][A-Z][a-z]{2}\s+\d{1,2}/g, ' ')
            .replace(/\$[\d,]+(?:[-–][\d,]+)?\/hr/gi, ' ')
            .replace(/\b\w+\s+collection/gi, ' ')
            .replace(/\+\s*\d+\b/g, ' ')
            .replace(/Internship(?=[A-Z])/g, ' ');
          // Match city/state — multi-word cities (e.g. "New York, NY") supported via inner group
          const locationMatch = cleanedText.match(
            /\b(remote|hybrid|on.?site|new york|san francisco|los angeles|nyc|boston|seattle|austin|chicago|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})\b/i
          );
          const location = locationMatch ? locationMatch[1].trim() : 'United States';

          return { title, company, location, link, jobId };
        }).filter(j => j.title && j.jobId);
      });

      const now = new Date().toISOString();
      for (const job of jobs) {
        results.push(buildInternshipRow({
          title: job.title,
          company: job.company,
          location: job.location,
          link: job.link,
          source: 'Handshake',
          seenAt: now,
        }));
      }

      console.log(`[handshake poller] Page ${pageNum}: ${jobs.length} jobs`);

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

// Simple concurrency pool: runs fn(item) for each item with at most `concurrency` concurrent calls.
async function withConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

const EXTERNAL_ATS_PATTERNS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'icims.com',
  'smartrecruiters.com', 'workday.com', 'taleo.net', 'successfactors',
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

  await withConcurrency(batch, concurrency, async (job) => {
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

        return { externalLink, description, descSelectorHit };
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

    // Auto-discover new ATS targets from extracted links
    const discovered = results
      .map(job => discoverATSTarget(job.link || '', job.company || ''))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const added = saveDiscoveredTargets(discovered);
    if (added > 0) {
      console.log(`[handshake poller] Auto-discovered ${added} new ATS target(s)`);
    }

    console.log(`[handshake poller] Total: ${results.length}`);
    return results;
  } catch (err: any) {
    console.error(`[handshake poller] Browser error: ${err.message}`);
    return [];
  } finally {
    await browser?.close();
  }
}
