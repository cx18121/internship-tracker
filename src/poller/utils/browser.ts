import type { Browser, BrowserContext } from 'playwright';
import { withTimeout } from './with-timeout';

// A headless Firefox under memory pressure (the Railway container runs several)
// can go unresponsive. Its lifecycle ops — newContext / context.close /
// browser.close — have NO timeout knob, so on a wedged browser they hang
// forever and deadlock the whole slow cycle. goto / evaluate / request are
// already bounded (~30s), so a wedge mid-work throws there and unwinds to the
// guarded close() in finally; these helpers bound the close() itself.
//
// Playwright's Browser from launch() exposes no OS-process handle, so we can't
// SIGKILL a wedged browser — we bound the await instead. The await rejects, the
// poller's try/catch unwinds, and the cycle recovers. A truly wedged browser
// may leak until the next process restart; the cycle watchdog (index.ts) +
// supervisor are the leak backstop. (Force-kill would need launchServer(),
// which risks the fragile Handshake Firefox/SSO flow — deferred on purpose.)

const CLOSE_TIMEOUT_MS = parseInt(process.env.BROWSER_CLOSE_TIMEOUT_MS || '15000', 10);

export async function closeBrowserSafely(browser: Browser | undefined, label: string): Promise<void> {
  if (!browser) return;
  try {
    await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, `${label} browser.close`);
  } catch (err: any) {
    console.warn(`[${label}] browser.close hung or failed (${err.message}) — leaving it for process restart`);
  }
}

export async function closeContextSafely(context: BrowserContext | undefined, label: string): Promise<void> {
  if (!context) return;
  try {
    await withTimeout(context.close(), CLOSE_TIMEOUT_MS, `${label} context.close`);
  } catch (err: any) {
    console.warn(`[${label}] context.close hung or failed (${err.message})`);
  }
}
