/**
 * Run this ONCE to authenticate with Handshake and save your session.
 * Usage: npx tsx src/handshake-login.ts
 *
 * A Firefox window will open. Log into Handshake via Cornell SSO.
 * Once you land on the jobs page, press Enter in the terminal to save and close.
 */
import { firefox } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const AUTH_PATH = path.join(process.cwd(), 'data', 'handshake-auth.json');
const JOBS_URL = 'https://app.joinhandshake.com/stu/jobs?employment_type_names[]=Internship&sort_direction=desc&sort_column=created_at';

async function main() {
  console.log('Opening Firefox — log into Handshake via Cornell SSO...');
  console.log('Once you see your job listings, come back here and press Enter.\n');

  const browser = await firefox.launch({
    headless: false, // visible window so you can log in
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  });

  const page = await context.newPage();
  await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for user to log in
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(resolve => rl.question('Press Enter when logged in and on the jobs page... ', () => { rl.close(); resolve(); }));

  // Save full session state (cookies + localStorage)
  await context.storageState({ path: AUTH_PATH });
  console.log(`\n✓ Session saved to ${AUTH_PATH}`);

  // Extract the _handshake_session cookie value to store in Mission Control vault
  const state = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
  const sessionCookie = state.cookies?.find((c: any) => c.name === '_handshake_session');
  const cookieValue = sessionCookie?.value || '';
  const savedAt = new Date().toISOString();

  // Update Mission Control secrets vault
  const MC_URL = process.env.MISSION_CONTROL_URL || 'http://localhost:3000';
  try {
    // Check if HANDSHAKE_TOKEN secret already exists
    const existing = await axios.get(`${MC_URL}/api/secrets`).then(r => r.data as any[]);
    const tokenSecret = existing.find((s: any) => s.name === 'HANDSHAKE_TOKEN');
    const authPathSecret = existing.find((s: any) => s.name === 'HANDSHAKE_AUTH_PATH');

    if (tokenSecret) {
      await axios.patch(`${MC_URL}/api/secrets/${tokenSecret.id}`, {
        value: cookieValue,
        description: `Handshake Cornell SSO session token — refreshed ${savedAt}`,
      });
    } else {
      await axios.post(`${MC_URL}/api/secrets`, {
        name: 'HANDSHAKE_TOKEN',
        value: cookieValue,
        description: `Handshake Cornell SSO session token — refreshed ${savedAt}`,
        category: 'api_key',
      });
    }

    if (authPathSecret) {
      await axios.patch(`${MC_URL}/api/secrets/${authPathSecret.id}`, {
        value: AUTH_PATH,
        description: `Path to Handshake Playwright session state — last saved ${savedAt}`,
      });
    } else {
      await axios.post(`${MC_URL}/api/secrets`, {
        name: 'HANDSHAKE_AUTH_PATH',
        value: AUTH_PATH,
        description: `Path to Handshake Playwright session state — last saved ${savedAt}`,
        category: 'api_key',
      });
    }

    console.log('✓ Mission Control vault updated (HANDSHAKE_TOKEN, HANDSHAKE_AUTH_PATH)');
  } catch (e: any) {
    console.warn('⚠ Could not update Mission Control vault:', e.message);
    console.log('  (session file is still saved and the poller will work regardless)');
  }

  // Update .env with refreshed token
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf-8');
    if (envContent.includes('HANDSHAKE_TOKEN=')) {
      envContent = envContent.replace(/^HANDSHAKE_TOKEN=.*/m, `HANDSHAKE_TOKEN=${cookieValue}`);
    } else {
      envContent += `\nHANDSHAKE_TOKEN=${cookieValue}`;
    }
    fs.writeFileSync(envPath, envContent);
    console.log('✓ .env updated with refreshed HANDSHAKE_TOKEN');
  }

  console.log('\nThe poller will now use this session automatically.\n');
  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
