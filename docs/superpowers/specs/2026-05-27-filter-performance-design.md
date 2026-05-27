# Filter & Load Performance — Design

**Date:** 2026-05-27
**Status:** Approved (pending spec review)
**Scope:** `src/app/page.tsx`, `src/app/_components/InternshipRow.tsx`, `src/app/_components/InternshipCard.tsx`, `src/app/_components/InternshipList.tsx`, `src/app/api/internships/route.ts`

## Problem

Pressing filter buttons feels laggy. The corpus is ~6,200 internships, loaded into the browser and filtered client-side. Three issues cause the lag:

1. **Filters that round-trip to the server.** `source` and `minScore` are wired into `fetchData`'s deps (`page.tsx:250, 259-264`). Clicking a source chip or changing min-score sets `loading=true`, blanks the list to a skeleton, refetches over the network, then re-renders. The skeleton flash is the primary "laggy" tell — and it is redundant: today the route forwards `source`/`minScore` into SQL (`route.ts:34`, `store.ts:587,594`) so the browser holds the *filtered* set, but the client *also* re-applies the same `minScore`/`includeSources` predicates via `applyFilterSpec` (`page.tsx:452-455`, `filter-spec.ts:86,93`). The client predicate is a **superset** of the server's, so dropping the server params makes the browser hold the full corpus and filter it down to the identical visible result — the server filtering changes nothing the user sees.

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
Keep the search `<input>` value updating immediately (controlled, instant feedback). Introduce a single debounced `appliedSearch` value (~120ms) and route **all three** of its current consumers off it together — filtering (`page.tsx:425`), the page-reset effect (`page.tsx:291`), and URL `replaceState` (`page.tsx:187`). Driving them off the debounced value as a unit avoids transient desync between the visible input, the URL, and the results (and a double page-reset). The `/` focus shortcut and Escape-to-clear behavior are unchanged.

**5. Trim the API list payload to list-needed fields. (Required — not deferred.)**
This is a real cost *today*, not just at 50k: `getInternships` does `SELECT *` and `fromRow` includes `description` (`store.ts:143`), so the list payload carries full descriptions even though the UI hides them — that is why `internships.json` is 3.8 MB at 6k rows. At 50k this becomes the dominant cold-load wall (transfer + parse + memory). Return only fields the UI reads.

Audit before removing any field:
- **UI reads:** `applyFilterSpec`, sorting, grouping by company, keyword/role chips, and `InternshipRow`/`InternshipCard` rendering.
- **External consumer:** `src/poller/scripts/find-ats-links-daily.ts` calls `/api/internships` and reads `id`, `title`, `company`, `link` — these must stay. (It also types the response as `{ data, count }` while the route returns a bare array; do not change the response shape as part of this work.)
- **Other API routes** under `src/app/api/internships/**` (e.g. score-breakdown) are separate endpoints and unaffected, but confirm none re-fetch the list route.
When in doubt, keep the field.

### Known remaining cost toward 50k (acknowledged, not addressed here)

Even fully memoized, each filter-state change still runs **three** whole-corpus passes — `filteredExcludingSeasons` (`page.tsx:444`), `filtered` + sort (`page.tsx:481`), and `tabCounts` (`page.tsx:533`). At 6k this is sub-frame; toward 50k it becomes the next bottleneck. This spec does not consolidate them — it's the logical follow-up once the network/skeleton and payload wins land and we can measure. Flagged so it isn't a surprise.

### Deferred (not built now)

- **List virtualization** — profile after core changes; add only if render time still dominates at target scale.
- **Server-side pagination** — the right move *beyond* ~50k. Note this is **not** a localized swap: filtering, tab counts, season counts, and total page count are all derived from the full in-memory corpus (`page.tsx:390,444,508`), so moving to server-side paging means redesigning all of those derivations together. Called out honestly as a larger future effort, not a drop-in.

## Verification

- **Behavior parity (Rule 5):** assert `filtered` output is identical before/after across a matrix of filter combinations (source, score, tier, season, role, applied, date, search). Guards against the perf change altering results.
- **No network on filter:** with the page loaded, click each filter and confirm via the Network tab that no `/api/internships` request fires and no skeleton appears.
- **No regression:** `tsc` clean; existing test suite (`npm test`) green.
- **Render isolation:** React Profiler shows toggling one row does not re-render sibling rows.

## Risks

- **Stable-callback refactor could break optimistic PATCH/rollback** (`useOptimisticPatch`, `writeAppliedDate`). Verify applied/hide toggles still optimistically update and roll back on failure.
- **Payload trimming could drop a field used somewhere non-obvious** (e.g. score-breakdown, keyword chips). Audit all field reads before removing any; when in doubt, keep the field.
- **Debounce could make search feel sluggish if too long.** Keep input value instant; debounce only the filter/URL derivation; tune interval if needed.
