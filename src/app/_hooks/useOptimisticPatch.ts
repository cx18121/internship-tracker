import { useCallback, useRef, useState } from "react";
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
  // Two parallel pending stores:
  //  - `pendingRef` is the source of truth for the in-flight guard. It mutates
  //    synchronously inside `patch`, so two same-row clicks fired in the same
  //    tick (before React re-renders) cannot both pass `has(id)` and race two
  //    PATCHes against each other.
  //  - `pendingIds` is the same set surfaced as React state so consumers can
  //    render disabled/aria-busy on the row. Updates lag a render behind the
  //    ref, but only UI flags care about that.
  const pendingRef = useRef<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  const setPending = useCallback((id: string, on: boolean) => {
    if (on) pendingRef.current.add(id);
    else pendingRef.current.delete(id);
    setPendingIds(new Set(pendingRef.current));
  }, []);

  const patch = useCallback(
    async (id: string, body: object, apply: () => void, revert: () => void): Promise<void> => {
      if (pendingRef.current.has(id)) return;
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
    [setPending],
  );

  return { pendingIds, patch };
}
