import { firefox } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const AUTH_PATH = path.join(process.cwd(), 'data', 'handshake-auth.json');
const JOBS_URL = 'https://app.joinhandshake.com/job-search?page=1&per_page=25&sort_direction=desc&sort_column=created_at&employment_type[]=Internship';

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

  const hooks = await page.evaluate(() => {
    const els = document.querySelectorAll('[data-hook]');
    const found = new Set<string>();
    els.forEach(el => found.add(el.getAttribute('data-hook') || ''));
    return Array.from(found).filter(h => h.includes('job') || h.includes('result') || h.includes('card') || h.includes('search'));
  });
  console.log('\nJob-related hooks:', hooks);

  const cardCount = await page.evaluate(() =>
    document.querySelectorAll('[data-hook^="job-result-card"]').length
  );
  console.log('job-result-card count:', cardCount);

  const sample = await page.evaluate(() => {
    const cards = document.querySelectorAll('[data-hook^="job-result-card"]');
    return Array.from(cards).slice(0, 3).map(c => ({
      hook: c.getAttribute('data-hook'),
      text: c.textContent?.trim().slice(0, 100),
    }));
  });
  console.log('Sample cards:', sample);

  await browser.close();
}

main().catch(e => console.error('Error:', e.message));
