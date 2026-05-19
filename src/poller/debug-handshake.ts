import { firefox } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const AUTH_PATH = path.join(process.cwd(), 'data', 'handshake-auth.json');
const JOBS_URL = 'https://app.joinhandshake.com/stu/jobs?employment_type_names[]=Internship&sort_direction=desc&sort_column=created_at';

async function main() {
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  console.log('URL:', page.url());
  console.log('Title:', await page.title());
  console.log('Logged in:', !page.url().includes('login'));

  // Find all data-hook attributes
  const hooks = await page.evaluate(() => {
    const els = document.querySelectorAll('[data-hook]');
    const found = new Set<string>();
    els.forEach(el => found.add(el.getAttribute('data-hook') || ''));
    return Array.from(found).filter(Boolean);
  });
  console.log('\ndata-hooks on page:', hooks);

  // Count potential job links
  const counts = await page.evaluate(() => ({
    jobLinks: document.querySelectorAll('a[href*="/jobs/"]').length,
    cards: document.querySelectorAll('[class*="card"]').length,
    jobCard: document.querySelectorAll('[data-hook="jobs-card"]').length,
    listItems: document.querySelectorAll('li[class*="job"], li[class*="result"]').length,
  }));
  console.log('\nElement counts:', counts);

  // Sample first few job link hrefs
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="/jobs/"]')).slice(0, 5).map(a => ({
      href: (a as HTMLAnchorElement).href,
      text: a.textContent?.trim().slice(0, 60),
    }))
  );
  console.log('\nSample job links:', links);

  // Save a snapshot of the HTML for inspection
  const html = await page.content();
  fs.writeFileSync('/tmp/handshake-debug.html', html);
  // Click the jobs sidebar link and follow where it goes
  const jobsLink = await page.$('[data-hook="student-sidebar-jobs-link"]');
  if (jobsLink) {
    await jobsLink.click();
    await page.waitForTimeout(4000);
    console.log('\nAfter clicking jobs link:');
    console.log('URL:', page.url());
    console.log('Title:', await page.title());

    const counts2 = await page.evaluate(() => ({
      jobLinks: document.querySelectorAll('a[href*="/jobs/"]').length,
      dataHooks: Array.from(document.querySelectorAll('[data-hook]'))
        .map(el => el.getAttribute('data-hook') || '')
        .filter(h => h.includes('job') || h.includes('card') || h.includes('search') || h.includes('result'))
    }));
    console.log('Job-related hooks:', counts2.dataHooks);
    console.log('Job links found:', counts2.jobLinks);

    // Sample first few hrefs
    const links2 = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/jobs/"]')).slice(0, 5).map(a => ({
        href: (a as HTMLAnchorElement).href,
        text: a.textContent?.trim().slice(0, 60),
      }))
    );
    console.log('Sample links:', links2);
  }

  fs.writeFileSync('/tmp/handshake-debug.html', await page.content());
  console.log('\nFull HTML saved to /tmp/handshake-debug.html');

  await browser.close();
}

main().catch(e => console.error('Error:', e.message));
