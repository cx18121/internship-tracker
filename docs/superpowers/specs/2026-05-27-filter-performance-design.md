# Filter & Load Performance — Design

**Date:** 2026-05-27
**Status:** Approved (pending spec review)
**Scope:** `src/app/page.tsx`, `src/app/_components/InternshipRow.tsx`, `src/app/_components/InternshipCard.tsx`, `src/app/_components/InternshipList.tsx`, `src/app/api/internships/route.ts`

## Problem

Pressing filter buttons feels laggy. The corpus is ~6,200 internships, loaded into the browser and filtered client-side. Three issues cause the lag:

1. **Filters that round-trip to the server.** `source` and `minScore` are wired into `fetchData`'s deps (`page.tsx:250, 259-264`). Clicking a source chip or changing min-score sets `loading=true`, blanks the list to a skeleton, refetches ~6k rows over the network, then re-renders. The skeleton flash is the primary "laggy" tell — and it is redundant: the API already returns the full corpus (`includeHidden=1`), and `applyFilterSpec` already re-applies `minScore` and `includeSources` client-side (`page.tsx:452-455`). The server filtering changes no results.

2. **Unmemoized filter/sort pipeline.** `filtered` and `paginated` (`page.tsx:481-510`) recompute on *every* render — every keystroke, hover, and toggle — over all ~6,200 rows. `filteredExcludingSeasons` and `tabCounts` are already memoized.

3. **Unmemoized rows + undebounced search.** Rows/cards have no `React.memo`, so toggling one row re-renders all visible rows. Search has no debounce, so each keystroke triggers a full-corpus sweep plus a `history.replaceState` write.

## Goal / Success Criteria

- Pressing any filter button (source, score, tier, season, role, applied, date) produces **zero network calls and zero skeleton flash**; results update in the same frame.
- Typing in search stays smooth at 6k rows and degrades gracefully toward 50k.
- **No change to which results display** for any filter combination. This is a pure-performance change (CLAUDE.md Rule 5: the change must not alter behavior).

Target scale: deployed site, corpus may grow to 50k+.

## Approaches Considered

- **A — Pure client-side filtering + memoization (chosen).** Fetch corpus once; remove `source`/`minScore` from the network path; memoize the pipeline; `React.memo` rows; debounce search. Biggest win, lowest risk, no backend change.
- **B — Server-side filtering + pagination.** Scales past 50k but makes every interaction a network round-trip — worse on Railway latency for filters that are currently instant. Wrong trade at this scale. Deferred as a future seam.
- **C — List virtualization (react-window).** Helps only if DOM render cost dominates. The list already paginates at 50, bounding DOM size. Deferred pending measurement.

## Design

### Core changes

**1. Decouple filtering from the network.**
Remove `selectedSources` and `minScore` from `fetchData`'s dependency array and from the request `params`. Corpus is fetched once after hydration and on manual Refresh only. All filtering (including source + score) runs in-memory via the existing `applyFilterSpec` chain. No `loading=true`, no skeleton, no round-trip on filter changes.

- `fetchData` keeps `includeHidden=1` (hidden is filtered client-side via the `showHidden` toggle).
- The mount/refresh fetch and AbortController logic stay; only the filter-driven re-fetch is removed.

**2. Memoize the filter/sort pipeline.**
Wrap `filtered` (filter + sort) and `paginated` (slice) in `useMemo` keyed on their real inputs (`internships`, the filter state, `sortBy`, `safePage`). Leave `filteredExcludingSeasons` and `tabCounts` as-is (already memoized). Full-corpus sweeps then run only when an input changes, not on every render.

**3. `React.memo` rows and cards.**
Wrap `InternshipRow` and `InternshipCard` in `React.memo`. Make their callback props referentially stable so memo holds: convert the inline arrow handlers passed from `page.tsx` / `InternshipList` into stable id-based handlers via `useCallback`. Toggling/applying one row must not re-render the other rows on the page.

**4. Debounce search.**
Keep the search `<input>` value updating immediately (controlled, instant feedback). Debounce the *derived* value used for filtering (~120ms) and the URL `replaceState` writes, so a keystroke burst triggers one sweep instead of one-per-character. The `/` focus shortcut and Escape-to-clear behavior are unchanged.

### Growth-readiness (included, low-risk)

**5. Trim the API list payload to list-needed fields.**
At 50k rows, initial JSON transfer/parse dominates cold load. Return only fields the UI reads. Descriptions are already omitted; audit `Internship` (wire type, `src/app/_lib/types.ts`) against what the list/card actually render and drop unused fields server-side in the list route. Must not remove any field consumed by `applyFilterSpec`, sorting, grouping, keyword/role chips, or row rendering.

### Deferred (not built now)

- **List virtualization** — profile after core changes; add only if render time still dominates at target scale.
- **Server-side pagination** — leave the data-fetch as a clean seam (single `fetchData` entry point) so this is a localized swap beyond ~50k. Not built now.

## Verification

- **Behavior parity (Rule 5):** assert `filtered` output is identical before/after across a matrix of filter combinations (source, score, tier, season, role, applied, date, search). Guards against the perf change altering results.
- **No network on filter:** with the page loaded, click each filter and confirm via the Network tab that no `/api/internships` request fires and no skeleton appears.
- **No regression:** `tsc` clean; existing test suite (`npm test`) green.
- **Render isolation:** React Profiler shows toggling one row does not re-render sibling rows.

## Risks

- **Stable-callback refactor could break optimistic PATCH/rollback** (`useOptimisticPatch`, `writeAppliedDate`). Verify applied/hide toggles still optimistically update and roll back on failure.
- **Payload trimming could drop a field used somewhere non-obvious** (e.g. score-breakdown, keyword chips). Audit all field reads before removing any; when in doubt, keep the field.
- **Debounce could make search feel sluggish if too long.** Keep input value instant; debounce only the filter/URL derivation; tune interval if needed.
