/**
 * Handshake session healthcheck.
 * Uses saved Playwright storage state (data/handshake-auth.json).
 * Exits 0 if session is valid, 1 if expired/not found.
 */
import { firefox } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

const AUTH_PATH = path.join(process.cwd(), 'data', 'handshake-auth.json');
const JOBS_URL = 'https://app.joinhandshake.com/stu/jobs';

async function main() {
  if (!fs.existsSync(AUTH_PATH)) {
    console.error('[healthcheck] handshake-auth.json not found — session never saved');
    process.exit(1);
  }

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  });

  const page = await context.newPage();
  try {
    await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    const url = page.url();
    const title = await page.title();

    const expired = url.includes('login') || url.includes('sign_in') || title.toLowerCase().includes('sign in');
    if (expired) {
      console.error(`[healthcheck] Session expired — redirected to: ${url}`);
      await browser.close();
      process.exit(1);
    }

    console.log(`[healthcheck] Session OK — ${url}`);
    await browser.close();
    process.exit(0);
  } catch (err: any) {
    console.error('[healthcheck] Error during probe:', err.message);
    await browser.close();
    process.exit(1);
  }
}

main();
