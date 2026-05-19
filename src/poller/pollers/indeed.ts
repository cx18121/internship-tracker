import { firefox } from 'playwright';
import { Internship } from '../../lib/types.js';

const SEARCH_QUERIES = [
  { q: 'software engineer intern', sort: 'date' },
  { q: 'software engineering internship', sort: 'date' },
  { q: 'machine learning intern', sort: 'date' },
  { q: 'backend engineer intern', sort: 'date' },
];

function buildSearchUrl(query: string): string {
  return `https://www.indeed.com/jobs?q=${encodeURIComponent(query)}&l=United+States&sort=date&fromage=3&limit=50`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function pollIndeed(): Promise<Partial<Internship>[]> {
  const seen = new Set<string>();
  const results: Partial<Internship>[] = [];

  let browser;
  try {
    browser = await firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        'general.appversion.override': '5.0 (Windows)',
        'general.oscpu.override': 'Windows NT 10.0; Win64; x64',
        'general.platform.override': 'Win32',
        'media.peerconnection.enabled': false,
      },
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    const page = await context.newPage();

    // Remove webdriver flag
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Warm up with homepage
    try {
      await page.goto('https://www.indeed.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2000 + Math.random() * 1000);
    } catch { /* continue anyway */ }

    for (const { q } of SEARCH_QUERIES) {
      try {
        const url = buildSearchUrl(q);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500 + Math.random() * 1000);

        // Extract job cards from the page
        const jobs = await page.evaluate(() => {
          const cards = document.querySelectorAll('[data-jk], .job_seen_beacon, .tapItem, .result');
          const extracted: any[] = [];

          cards.forEach((card) => {
            const titleEl = card.querySelector('h2.jobTitle a, [data-testid="job-title"] a, .jcs-JobTitle, h2 a');
            const companyEl = card.querySelector('[data-testid="company-name"], .companyName, .company');
            const locationEl = card.querySelector('[data-testid="job-location"], .companyLocation, .location');
            const dateEl = card.querySelector('[data-testid="myJobsStateDate"], .date, .resultContent .attribute_snippet');
            const snippetEl = card.querySelector('.job-snippet, .summary, [data-testid="job-snippet"]');

            const title = titleEl?.textContent?.trim();
            const company = companyEl?.textContent?.trim();
            const location = locationEl?.textContent?.trim();
            const description = snippetEl?.textContent?.trim() || '';
            const link = titleEl?.getAttribute('href') || (card.querySelector('a[href*="/viewjob"]') as HTMLAnchorElement)?.href || '';
            const jk = card.getAttribute('data-jk') || '';

            if (title && (company || jk)) {
              extracted.push({ title, company: company || 'Unknown', location: location || null, description, link: link || jk, postedDate: dateEl?.textContent?.trim() });
            }
          });

          return extracted;
        });

        for (const job of jobs) {
          const link = job.link?.startsWith('http')
            ? job.link
            : `https://www.indeed.com${job.link}`;
          const key = `${job.title}|${job.company}`;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            title: job.title,
            company: job.company,
            location: job.location,
            description: job.description?.slice(0, 1000),
            link,
            source: 'Indeed',
            postedAt: new Date().toISOString(),
            seenAt: new Date().toISOString(),
            applied: false,
          });
        }

        console.log(`[indeed poller] "${q}" → ${jobs.length} jobs`);
      } catch (err: any) {
        console.warn(`[indeed poller] Failed "${q}": ${err.message}`);
      }
    }

    await context.close();
  } catch (err: any) {
    console.error(`[indeed poller] Browser error: ${err.message}`);
  } finally {
    await browser?.close();
  }

  console.log(`[indeed poller] Total: ${results.length}`);
  return results;
}
