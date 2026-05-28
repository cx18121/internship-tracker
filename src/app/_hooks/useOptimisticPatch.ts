import { useCallback, useState } from "react";
import { ownerHeader } from "../_lib/ownerHeader";

/**
 * Per-row optimistic PATCH against /api/internships/:id with rollback on
 * failure. Replaces the side-by-side copies of `toggleApplied` and
 * `patchHidden` in page.tsx — both had the same shape: pending guard →
 * apply local state → fetch PATCH → revert on !ok → clear pending.
 *
 * The caller supplies `apply` and `revert` callbacks so each consumer can
 * fan out to whatever local state it owns (the internships list, an
 * applied-dates map, localStorage, etc.). The hook owns:
 *   - pending-id tracking (rapid double-clicks on the same row are dropped
 *     so we can't race two stale PATCHes and end up wrong-side-up)
 *   - the network call + ok/!ok branch + rollback invocation
 */
export function useOptimisticPatch(): {
  pendingIds: Set<string>;
  patch: (id: string, body: object, apply: () => void, revert: () => void) => Promise<void>;
} {
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  const setPending = useCallback((id: string, on: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const patch = useCallback(
    async (id: string, body: object, apply: () => void, revert: () => void): Promise<void> => {
      if (pendingIds.has(id)) return;
      setPending(id, true);
      apply();

      let ok = false;
      try {
        const res = await fetch(`/api/internships/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...ownerHeader() },
          body: JSON.stringify(body),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }

      // fetch() resolves with res.ok === false for 4xx/5xx, so a non-thrown
      // failed PATCH would silently leave the UI in the optimistic state
      // while the DB rejected the change. Revert explicitly.
      if (!ok) revert();
      setPending(id, false);
    },
    [pendingIds, setPending],
  );

  return { pendingIds, patch };
}
