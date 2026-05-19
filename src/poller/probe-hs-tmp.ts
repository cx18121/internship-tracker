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

  // Step 1: landing page
  await page.goto('https://app.joinhandshake.com/stu/jobs', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('After landing:', page.url());

  // Step 2: direct URL
  await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  console.log('After jobs URL:', page.url());

  // Check cards
  const info = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[data-hook]')).map(e => e.getAttribute('data-hook') || '');
    const cards = all.filter(h => h.includes('job-result-card'));
    return { cardHooks: cards.slice(0, 5), totalHooks: all.length };
  });
  console.log('Card hooks:', info.cardHooks);
  console.log('Total hooks on page:', info.totalHooks);

  // Try waiting for selector explicitly
  try {
    await page.waitForSelector('[data-hook^="job-result-card"]', { timeout: 10000 });
    console.log('Selector found after explicit wait!');
  } catch {
    console.log('Selector NOT found after 10s wait');
  }

  // Try with networkidle
  await page.goto(JOBS_URL, { waitUntil: 'networkidle', timeout: 30000 });
  const info2 = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[data-hook]')).map(e => e.getAttribute('data-hook') || '');
    return all.filter(h => h.includes('job-result-card')).slice(0, 5);
  });
  console.log('After networkidle, card hooks:', info2);

  await browser.close();
}
main().catch(e => console.error(e));
