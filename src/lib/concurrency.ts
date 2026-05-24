/**
 * Worker-pool helper used by every poller. Spawns up to `limit` parallel
 * workers, each pulling items off a shared queue until it's drained.
 *
 * Replaces 5+ inline copies of the same pattern across the poller. Workers
 * receive the item AND their index — LinkedIn uses the index to stagger
 * politeness jitter so concurrent workers don't fire requests in lockstep.
 *
 * Errors thrown from `fn` propagate (Promise.all rejects on the first
 * failure). Pollers that need per-item error isolation should wrap fn's
 * body in try/catch themselves — pool deliberately doesn't swallow.
 */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, workerIdx: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0 || limit < 1) return;
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async (_, workerIdx) => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) return;
        await fn(item, workerIdx);
      }
    },
  );
  await Promise.all(workers);
}
