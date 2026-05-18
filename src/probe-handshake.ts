import axios from 'axios';
import { firefox } from 'playwright';
import * as dotenv from 'dotenv';
dotenv.config();

const token = process.env.HANDSHAKE_TOKEN!;

async function probeAxios() {
  // Try different auth styles on the endpoint that returned 403 (exists but denied)
  const attempts = [
    { label: 'bearer', headers: { 'Authorization': `Bearer ${token}` } },
    { label: 'cookie _handshake_session', headers: { 'Cookie': `_handshake_session=${token}` } },
    { label: 'cookie session', headers: { 'Cookie': `session=${token}` } },
    { label: 'cookie + bearer', headers: { 'Authorization': `Bearer ${token}`, 'Cookie': `_handshake_session=${token}` } },
  ];

  for (const { label, headers } of attempts) {
    try {
      const res = await axios.get('https://app.joinhandshake.com/stu/jobs.json?employment_type_names[]=Internship&per_page=3', {
        headers: { ...headers, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://app.joinhandshake.com/stu/jobs' },
        timeout: 8000,
      });
      console.log(`✓ [${label}] status: ${res.status} | keys: ${Object.keys(res.data || {}).join(', ')}`);
      if (res.data?.results) console.log('  First job:', res.data.results[0]?.title, '@', res.data.results[0]?.employer?.name);
    } catch(e: any) {
      console.log(`✗ [${label}] → ${e.response?.status || e.message}`);
    }
  }
}

async function probeBrowser() {
  console.log('\nTrying browser approach with cookie...');
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  });

  await context.addCookies([{
    name: '_handshake_session',
    value: token,
    domain: 'app.joinhandshake.com',
    path: '/',
    httpOnly: true,
    secure: true,
  }]);

  const page = await context.newPage();
  try {
    await page.goto('https://app.joinhandshake.com/stu/jobs', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    const url = page.url();
    const title = await page.title();
    console.log('Browser landed on:', url);
    console.log('Page title:', title);

    // Check if we're logged in
    const isLoggedIn = !url.includes('login') && !url.includes('sign_in') && !title.toLowerCase().includes('sign in');
    console.log('Logged in:', isLoggedIn);

    if (isLoggedIn) {
      // Try JSON endpoint with cookies from browser context
      const response = await page.evaluate(async () => {
        const r = await fetch('/stu/jobs.json?employment_type_names[]=Internship&per_page=5', {
          headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
        });
        return { status: r.status, data: await r.json().catch(() => null) };
      });
      console.log('Fetch from browser:', response.status, Object.keys(response.data || {}).join(', '));
      if (response.data?.results?.[0]) {
        console.log('First job:', response.data.results[0].title, '@', response.data.results[0].employer?.name);
      }
    }
  } catch(e: any) {
    console.error('Browser error:', e.message);
  }

  await browser.close();
}

async function main() {
  await probeAxios();
  await probeBrowser();
}

main();
