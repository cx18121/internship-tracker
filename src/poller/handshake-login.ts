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

  // Extract the Handshake session cookie value to update .env.
  // Handshake renamed _handshake_session → _trajectory_session at some point;
  // prefer the cornell.* domain copy (it's the SSO-authenticated one).
  const state = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
  const sessionCookie =
    state.cookies?.find((c: any) => c.name === '_trajectory_session' && c.domain?.startsWith('cornell.')) ??
    state.cookies?.find((c: any) => c.name === '_trajectory_session') ??
    state.cookies?.find((c: any) => c.name === '_handshake_session');
  const cookieValue = sessionCookie?.value || '';

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
