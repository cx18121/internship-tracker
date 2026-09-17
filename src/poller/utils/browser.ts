import type { Browser } from 'playwright';
import { withTimeout } from './with-timeout';

// browser.close() has no timeout and hangs forever on a wedged headless
// browser, which would deadlock the slow cycle. Bound the await; a truly
// wedged browser leaks until the cycle watchdog restarts the process.

const CLOSE_TIMEOUT_MS = parseInt(process.env.BROWSER_CLOSE_TIMEOUT_MS || '15000', 10);

export async function closeBrowserSafely(browser: Browser | undefined, label: string): Promise<void> {
  if (!browser) return;
  try {
    await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, `${label} browser.close`);
  } catch (err) {
    console.warn(`[${label}] browser.close hung or failed (${err instanceof Error ? err.message : err}) — leaving it for process restart`);
  }
}
