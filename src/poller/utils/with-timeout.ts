/**
 * Reject if `promise` doesn't settle within `ms`.
 *
 * The underlying promise is NOT cancelled — JS has no cancellation. A caller
 * wrapping a resource-holding op (a headless browser, a subprocess) must ensure
 * its own finally/cleanup runs on the rejection, or rely on a coarser backstop
 * (the poller's per-cycle watchdog, which exits the process on a true wedge so
 * the supervisor restarts it clean).
 *
 * Used in two places:
 *   - index.ts wraps each poll cycle so a hung cycle can't deadlock the
 *     in-flight lock forever (the bug this was written for).
 *   - the Playwright pollers wrap page.evaluate — the one Playwright op with no
 *     built-in timeout (launch/goto/request all default to ~30s).
 *
 * The error message starts with `label + ' exceeded'` so callers can tell a
 * watchdog trip apart from an ordinary failure of the wrapped work.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // NOT unref'd on purpose: if the wrapped promise hangs and nothing else is
    // keeping the loop alive, we still want this timer to fire and reject. The
    // timer is cleared the instant the promise settles, so it never delays a
    // clean exit in the normal case.
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${ms}ms timeout`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
