# Filter & Load Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every filter interaction instant (no network round-trip, no skeleton flash) and cut cold-load payload, without changing which results display.

**Architecture:** All filtering stays client-side. Task 1 removes the redundant server-side `source`/`minScore` refetch (the client already re-applies both via `applyFilterSpec`). Tasks 2–3 extract the payload projection and the filter/sort pipeline into pure, unit-testable modules. Tasks 4–5 stop unnecessary re-renders (`React.memo` + stable callbacks) and debounce search.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript. Tests run via the existing node harness `src/poller/test.ts` (`npm test`) — a custom `test()`/`assert` runner, no React test infra. React-render and network behavior are verified with `tsc` + manual DevTools checks (stated per task).

**Reference:** `docs/superpowers/specs/2026-05-27-filter-performance-design.md`

---

## Pre-flight

- [ ] **Confirm clean baseline**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; test harness prints `PASS` lines and a passing summary. Note the pass count — later tasks must not reduce it.

---

## Task 1: Decouple source/minScore filters from the network

**Why first:** This alone removes the skeleton-flash lag — the headline complaint. No new files.

**Files:**
- Modify: `src/app/page.tsx` (the `fetchData` callback ~220-250 and its effect deps)

- [ ] **Step 1: Remove source/minScore from the request params**

In `src/app/page.tsx`, inside `fetchData`, delete the two lines that add `source` and `minScore` to `params`. The corpus is fetched whole; the client filters it. Before:

```ts
      const params = new URLSearchParams();
      if (selectedSources.length === 1) params.set("source", selectedSources[0]);
      if (minScore > 0) params.set("minScore", String(minScore));
      // Always fetch hidden so the toggle is instant; filter client-side.
      params.set("includeHidden", "1");

      const listRes = await fetch(`/api/internships?${params.toString()}`, { signal });
```

After:

```ts
      // Fetch the full corpus once; ALL filtering (source, score, tier,
      // season, …) runs client-side via applyFilterSpec. No filter change
      // triggers a network call or skeleton flash.
      const listRes = await fetch(`/api/internships?includeHidden=1`, { signal });
```

- [ ] **Step 2: Drop selectedSources/minScore from fetchData's dependency array**

Change the `useCallback` deps for `fetchData` from `[selectedSources, minScore]` to `[]`:

```ts
  }, []);
```

(The body no longer references either value. The effect at ~259-264 that calls `fetchData(false, abort.signal)` keeps its `[hydrated, fetchData]` deps; with `fetchData` now stable it fires once after hydration and on manual Refresh only.)

- [ ] **Step 3: Verify types and behavior**

Run: `npx tsc --noEmit`
Expected: clean.

Manual (DevTools): `npm run dev`, open the app, open the Network tab. Click several source chips and drag min-score. Expected: **no new `/api/internships` request** fires and the list does **not** flash a skeleton — results update instantly. Confirm the result set for a source filter matches what it showed before this change.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "perf: filter client-side only — drop redundant source/minScore refetch"
```

---

## Task 2: Trim the list API payload to UI-needed fields

**Files:**
- Create: `src/app/_lib/list-item.ts`
- Test: add cases to `src/poller/test.ts`
- Modify: `src/app/api/internships/route.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/poller/test.ts` (near the other `test(...)` blocks; add the import at the top with the other imports):

```ts
import { pickListFields, LIST_FIELDS } from '../app/_lib/list-item';
```

```ts
test('pickListFields keeps UI/consumer fields and drops heavy unused ones', () => {
  const full = {
    id: 'x1', title: 'SWE Intern', company: 'Acme', location: 'NYC',
    link: 'https://a.co/x1', source: 'Greenhouse', postedAt: '2026-01-01',
    seenAt: '2026-01-02', score: 88, scoreLabel: 'A',
    matchedKeywords: ['backend'], applied: false, hidden: false,
    salaryText: '$50/hr', season: ['summer-2026'],
    // fields that must NOT ship to the list view:
    description: 'x'.repeat(5000), salaryMin: 50, salaryMax: 60,
    salaryUnit: 'hourly', isNew: true,
  };
  const out = pickListFields(full as any);
  // Required by ATS consumer (find-ats-links-daily.ts) + the list/card UI.
  for (const f of ['id', 'title', 'company', 'link', 'source', 'score',
                   'scoreLabel', 'postedAt', 'seenAt', 'location',
                   'matchedKeywords', 'applied', 'hidden', 'salaryText', 'season']) {
    assert(f in out, `expected field ${f} to be kept`);
  }
  // Heavy / unused — must be dropped.
  for (const f of ['description', 'salaryMin', 'salaryMax', 'salaryUnit', 'isNew']) {
    assert(!(f in out), `expected field ${f} to be dropped`);
  }
  // The allowlist and the output keys agree.
  assert.deepStrictEqual(Object.keys(out).sort(), [...LIST_FIELDS].sort());
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../app/_lib/list-item'` (module not created yet).

- [ ] **Step 3: Create the projection module**

Create `src/app/_lib/list-item.ts`:

```ts
import type { Internship } from "@/lib/types";

// Allowlist of fields the list view + its external consumer
// (src/poller/scripts/find-ats-links-daily.ts: id/title/company/link)
// actually read. Everything else — notably `description` (multi-KB per
// row, hidden from the UI), the numeric salary fields, and `isNew` — is
// dropped from the list payload to keep transfer/parse cheap as the
// corpus grows. See docs/superpowers/specs/2026-05-27-filter-performance-design.md.
export const LIST_FIELDS = [
  "id", "title", "company", "location", "link", "source",
  "postedAt", "seenAt", "score", "scoreLabel", "matchedKeywords",
  "applied", "hidden", "salaryText", "season",
] as const;

export type ListItem = Pick<Internship, (typeof LIST_FIELDS)[number]>;

/** Project a storage Internship down to the list-view allowlist. */
export function pickListFields(i: Internship): ListItem {
  const out = {} as Record<string, unknown>;
  for (const f of LIST_FIELDS) {
    if (i[f] !== undefined) out[f] = i[f];
  }
  return out as ListItem;
}
```

Note: if `Pick<Internship, …>` errors because a `LIST_FIELDS` name is absent from the storage `Internship` type (`src/lib/types.ts`), open that type and use the exact field names it declares (e.g. `seenAt` vs `seen_at`). The storage type is camelCase (matches `fromRow` output), so the names above should align — confirm before editing.

- [ ] **Step 4: Apply the projection in the route**

Modify `src/app/api/internships/route.ts`. Add the import:

```ts
import { pickListFields } from "@/app/_lib/list-item";
```

Change the final two lines from:

```ts
  const all = await getInternships({ source, sources, minScore, label, sort, search: q, includeHidden });
  const sliced = limit !== undefined ? all.slice(offset, offset + limit) : all.slice(offset);
  return Response.json(sliced);
```

to:

```ts
  const all = await getInternships({ source, sources, minScore, label, sort, search: q, includeHidden });
  const sliced = limit !== undefined ? all.slice(offset, offset + limit) : all.slice(offset);
  return Response.json(sliced.map(pickListFields));
```

(Response stays a bare array — the ATS consumer's `axios` reads `response.data` as the array; do not wrap it.)

- [ ] **Step 5: Run tests and type-check**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; the new test prints `PASS  pickListFields keeps UI/consumer fields and drops heavy unused ones`; pass count ≥ baseline.

- [ ] **Step 6: Manual payload check**

Run: `npm run dev`, then in another shell:
Run: `curl -s 'http://localhost:3001/api/internships?includeHidden=1' | head -c 400; echo`
Expected: JSON array whose first object has no `description`/`salaryMin` keys but does have `id`/`title`/`company`/`link`/`score`.

- [ ] **Step 7: Commit**

```bash
git add src/app/_lib/list-item.ts src/app/api/internships/route.ts src/poller/test.ts
git commit -m "perf: trim list API payload to UI-needed fields (drop description et al)"
```

---

## Task 3: Extract pure filter+sort pipeline, add parity tests, memoize

**Files:**
- Create: `src/app/_lib/filter-pipeline.ts`
- Test: add cases to `src/poller/test.ts`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Write the failing parity tests**

These encode *why* the filters matter (Rule 5), not a tautological before/after. Add the import to `src/poller/test.ts`:

```ts
import { filterAndSortInternships } from '../app/_lib/filter-pipeline';
```

```ts
test('filterAndSortInternships: minScore + source gate, score-desc order', () => {
  const corpus = [
    { id: 'a', title: 'SWE', company: 'A', location: 'NYC', source: 'Greenhouse', score: 90, applied: false, hidden: false, matchedKeywords: [] },
    { id: 'b', title: 'SWE', company: 'B', location: 'NYC', source: 'Indeed',     score: 40, applied: false, hidden: false, matchedKeywords: [] },
    { id: 'c', title: 'SWE', company: 'C', location: 'NYC', source: 'Greenhouse', score: 70, applied: false, hidden: false, matchedKeywords: [] },
  ] as any[];
  const out = filterAndSortInternships(corpus, {
    searchLower: '', selectedLocations: [], locationText: '',
    tier: 'all', seasons: [], appliedFilter: 'all', showHidden: false,
    selectedSources: ['Greenhouse'], minScore: 50, windowCutoff: null,
    includeKeywords: [], excludeKeywords: [], selectedRoles: [], sortBy: 'score',
  });
  // Indeed row excluded by source; score-40 row excluded by minScore;
  // remaining ordered score-desc.
  assert.deepStrictEqual(out.map(i => i.id), ['a', 'c']);
});

test('filterAndSortInternships: search matches company/title/location, hidden excluded unless showHidden', () => {
  const corpus = [
    { id: 'a', title: 'Backend Intern', company: 'Acme', location: 'NYC', source: 'X', score: 50, applied: false, hidden: false, matchedKeywords: [] },
    { id: 'b', title: 'Frontend Intern', company: 'Beta', location: 'SF', source: 'X', score: 60, applied: false, hidden: true, matchedKeywords: [] },
  ] as any[];
  const base = {
    selectedLocations: [], locationText: '', tier: 'all' as const, seasons: [],
    appliedFilter: 'all' as const, selectedSources: [], minScore: 0, windowCutoff: null,
    includeKeywords: [], excludeKeywords: [], selectedRoles: [], sortBy: 'score' as const,
  };
  // Search "acme" hits company on row a only.
  assert.deepStrictEqual(
    filterAndSortInternships(corpus, { ...base, searchLower: 'acme', showHidden: false }).map(i => i.id),
    ['a'],
  );
  // Hidden row b is excluded by default, included when showHidden.
  assert.deepStrictEqual(
    filterAndSortInternships(corpus, { ...base, searchLower: '', showHidden: false }).map(i => i.id),
    ['a'],
  );
  assert.deepStrictEqual(
    filterAndSortInternships(corpus, { ...base, searchLower: '', showHidden: true }).map(i => i.id).sort(),
    ['a', 'b'],
  );
});

test('filterAndSortInternships: sortBy posted orders by postedAt desc', () => {
  const corpus = [
    { id: 'old', title: 'T', company: 'C', location: 'L', source: 'X', score: 99, postedAt: '2026-01-01', applied: false, hidden: false, matchedKeywords: [] },
    { id: 'new', title: 'T', company: 'C', location: 'L', source: 'X', score: 10, postedAt: '2026-05-01', applied: false, hidden: false, matchedKeywords: [] },
  ] as any[];
  const out = filterAndSortInternships(corpus, {
    searchLower: '', selectedLocations: [], locationText: '', tier: 'all', seasons: [],
    appliedFilter: 'all', showHidden: false, selectedSources: [], minScore: 0,
    windowCutoff: null, includeKeywords: [], excludeKeywords: [], selectedRoles: [], sortBy: 'posted',
  });
  assert.deepStrictEqual(out.map(i => i.id), ['new', 'old']); // newest first, ignores score
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../app/_lib/filter-pipeline'`.

- [ ] **Step 3: Create the pure pipeline module**

Create `src/app/_lib/filter-pipeline.ts`. This lifts the exact logic currently inlined in `page.tsx` (`passesLocalPredicates` at ~426-439 and the `filtered` filter+sort at ~481-505) into a pure function so it is testable and memoizable.

```ts
import type { Internship, AppliedFilter, TierFilter, SortBy } from "./types";
import type { RoleId } from "@/lib/role-taxonomy";
import { applyFilterSpec } from "@/lib/filter-spec";

export interface LocalPredicateInput {
  searchLower: string;
  selectedLocations: string[];
  locationText: string;
}

// Free-text search + substring location — the app-only predicates that are
// NOT part of the shared filter spec. Mirrors page.tsx's prior inline block
// verbatim so the season-count and tab-count derivations stay consistent.
export function passesLocalPredicates(i: Internship, p: LocalPredicateInput): boolean {
  if (p.searchLower) {
    const hay = `${i.company} ${i.title} ${i.location ?? ""}`.toLowerCase();
    if (!hay.includes(p.searchLower)) return false;
  }
  if (p.selectedLocations.length > 0 || p.locationText) {
    const loc = i.location.toLowerCase();
    const locMatch = p.selectedLocations.some((l) => loc.includes(l.toLowerCase()));
    const textMatch = p.locationText ? loc.includes(p.locationText.toLowerCase()) : false;
    if (!locMatch && !textMatch && !(p.selectedLocations.length === 0)) return false;
    if (p.selectedLocations.length === 0 && p.locationText && !textMatch) return false;
  }
  return true;
}

export interface FilterCriteria extends LocalPredicateInput {
  tier: TierFilter;
  seasons: string[];
  appliedFilter: AppliedFilter;
  showHidden: boolean;
  selectedSources: string[];
  minScore: number;
  windowCutoff: number | null;
  includeKeywords: string[];
  excludeKeywords: string[];
  selectedRoles: RoleId[];
  sortBy: SortBy;
}

export function filterAndSortInternships(
  internships: Internship[],
  c: FilterCriteria,
): Internship[] {
  return internships
    .filter((i) => {
      if (!passesLocalPredicates(i, c)) return false;
      return applyFilterSpec(i, {
        tier: c.tier,
        seasons: c.seasons,
        appliedFilter: c.appliedFilter,
        excludeHidden: !c.showHidden,
        includeSources: c.selectedSources,
        minScore: c.minScore,
        postedAfter: c.windowCutoff ?? undefined,
        includeKeywords: c.includeKeywords,
        excludeKeywords: c.excludeKeywords,
        roles: c.selectedRoles,
      });
    })
    .sort((a, b) => {
      if (c.sortBy === "posted") {
        return new Date(b.postedAt ?? 0).getTime() - new Date(a.postedAt ?? 0).getTime();
      }
      return (b.score ?? -1) - (a.score ?? -1);
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: the three `filterAndSortInternships` tests print `PASS`.

- [ ] **Step 5: Refactor page.tsx to use the module + memoize**

In `src/app/page.tsx`:

(a) Add the import alongside the existing `applyFilterSpec` import:

```ts
import { passesLocalPredicates as passesLocal, filterAndSortInternships } from "./_lib/filter-pipeline";
```

(b) Replace the inline `passesLocalPredicates` `useCallback` (~426-439) with one that delegates to the module (keeps the same name + signature so `filteredExcludingSeasons` and `tabCounts` are untouched):

```ts
  const searchLower = searchText.trim().toLowerCase();
  const passesLocalPredicates = useCallback(
    (i: Internship): boolean =>
      passesLocal(i, { searchLower, selectedLocations, locationText }),
    [searchLower, selectedLocations, locationText],
  );
```

(c) Replace the bare `filtered` expression (~481-505) with a memoized call:

```ts
  const filtered = useMemo(
    () =>
      filterAndSortInternships(internships, {
        searchLower, selectedLocations, locationText,
        tier: tierFilter, seasons: selectedSeasons, appliedFilter, showHidden,
        selectedSources, minScore, windowCutoff,
        includeKeywords, excludeKeywords, selectedRoles, sortBy,
      }),
    [
      internships, searchLower, selectedLocations, locationText,
      tierFilter, selectedSeasons, appliedFilter, showHidden,
      selectedSources, minScore, windowCutoff,
      includeKeywords, excludeKeywords, selectedRoles, sortBy,
    ],
  );
```

(d) Memoize `paginated` (currently `filtered.slice(...)` at ~510). Note `totalPages`/`safePage` are cheap and stay as-is; only the slice is wrapped:

```ts
  const paginated = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; full suite ≥ baseline pass count.

Manual: `npm run dev`, exercise every filter (source, score, tier, season, role, applied tabs, date window, search) and confirm result counts/order are unchanged from before the refactor.

- [ ] **Step 7: Commit**

```bash
git add src/app/_lib/filter-pipeline.ts src/app/page.tsx src/poller/test.ts
git commit -m "perf: extract pure filter+sort pipeline, add parity tests, memoize"
```

---

## Task 4: React.memo rows and cards with stable callbacks

**Files:**
- Modify: `src/app/_components/InternshipRow.tsx`
- Modify: `src/app/_components/InternshipCard.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Memoize InternshipRow**

In `src/app/_components/InternshipRow.tsx`, import `memo` and wrap the export. The component currently is `export function InternshipRow(props: Props) { … }`. Change to a non-exported function plus a memoized export:

```ts
import { memo } from "react";
```

Rename the declaration `export function InternshipRow(` → `function InternshipRowImpl(`, and at the end of the file add:

```ts
export const InternshipRow = memo(InternshipRowImpl);
```

(Keep the existing `export const LIST_GRID_COLS = …` as-is — it is imported by `InternshipList`.)

- [ ] **Step 2: Memoize InternshipCard**

In `src/app/_components/InternshipCard.tsx`:

```ts
import { useState, memo } from "react";
```

Rename `export function InternshipCard(` → `function InternshipCardImpl(`, and add at the end:

```ts
export const InternshipCard = memo(InternshipCardImpl);
```

- [ ] **Step 3: Stabilize the handler functions in page.tsx**

`memo` only pays off when the handler functions themselves keep a stable identity across unrelated renders (search typing, opening the notif modal, etc.). Today `toggleApplied`, `hidePosting`, `unhidePosting`, `patchInternshipField`, `updateNote`, and `writeAppliedDate` are recreated every render. Wrap each in `useCallback`, keeping its existing body verbatim — only the wrapper and dependency array change.

Dependency arrays to use (each handler closes over exactly these):

```ts
  // writeAppliedDate: only setState setters (stable) → []
  const writeAppliedDate = useCallback((id: string, on: boolean): void => { /* existing body */ }, []);

  // patchInternshipField closes over patch (from useOptimisticPatch) + writeAppliedDate
  const patchInternshipField = useCallback(/* existing generic body */, [patch, writeAppliedDate]);

  const toggleApplied = useCallback(
    (id: string, current: boolean) => { void patchInternshipField(id, "applied", !current, current); },
    [patchInternshipField],
  );
  const hidePosting = useCallback((id: string) => { void patchInternshipField(id, "hidden", true, false); }, [patchInternshipField]);
  const unhidePosting = useCallback((id: string) => { void patchInternshipField(id, "hidden", false, true); }, [patchInternshipField]);
  const updateNote = useCallback((id: string, note: string) => { /* existing body */ }, []);
```

`patch` (from `useOptimisticPatch`) intentionally changes identity with `pendingIds`, so these handlers re-create while a PATCH is in flight. That is correct and required — the rollback closure must observe current state, not a stale snapshot (verified in Step 5).

Do **not** change the prop signatures of `InternshipRow`/`InternshipCard`, and do **not** change the existing call sites:
- `InternshipList` keeps its `onToggleApplied={toggleApplied}` / `onHide={…}` props — now backed by stable functions.
- The card grid keeps its per-item `() => toggleApplied(item.id, item.applied)` arrows. These still allocate per item, but with the corpus paginated at `PAGE_SIZE` (50) that is negligible; the win is that `memo` now blocks re-renders driven by *unrelated* parent state, because `item`/`appliedDate`/`notes`/`pending` stay referentially stable for unaffected rows.

- [ ] **Step 4: Verify types and render isolation**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; suite ≥ baseline.

Manual (React DevTools Profiler): `npm run dev`, enable "Highlight updates when components render". Toggle Applied on one row. Expected: only that row (and the count/toolbar) flashes — sibling rows do not re-render. Type in search: rows that remain visible and unchanged should not all re-flash on every keystroke (after Task 5's debounce this is most visible).

- [ ] **Step 5: Verify optimistic patch still works**

Manual: toggle Applied and Hide on a row; confirm the UI updates immediately (optimistic) and that the change persists after a Refresh. To confirm rollback: in DevTools Network, set the PATCH to fail (offline mode) and toggle — the row must revert to its prior state.

- [ ] **Step 6: Commit**

```bash
git add src/app/_components/InternshipRow.tsx src/app/_components/InternshipCard.tsx src/app/page.tsx
git commit -m "perf: React.memo rows/cards + stabilize handler identity"
```

---

## Task 5: Debounce search

**Files:**
- Create: `src/app/_hooks/useDebouncedValue.ts`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Create the debounce hook**

Create `src/app/_hooks/useDebouncedValue.ts`:

```ts
import { useEffect, useState } from "react";

/** Returns `value` delayed by `delayMs`; resets the timer on each change. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
```

- [ ] **Step 2: Route filtering/URL/page-reset off the debounced value**

In `src/app/page.tsx`:

(a) Import the hook:

```ts
import { useDebouncedValue } from "./_hooks/useDebouncedValue";
```

(b) Derive a debounced search value. The `<input>` stays bound to `searchText` (instant typing); only the *derived* value used downstream is debounced:

```ts
  const debouncedSearch = useDebouncedValue(searchText, 120);
  const searchLower = debouncedSearch.trim().toLowerCase();
```

(Replace the existing `const searchLower = searchText.trim().toLowerCase();` line.)

(c) In the **URL-sync effect** (~187-218), change the search write to use the debounced value and update the dependency array (`searchText` → `debouncedSearch`):

```ts
    if (debouncedSearch) params.set("q", debouncedSearch);
```

(d) In the **page-reset effect** (~291-299), swap `searchText` for `debouncedSearch` in the dependency array so the reset to page 1 fires once per settled query, not per keystroke.

> Both effects and the `filtered` memo (Task 3, which already keys on `searchLower`) now derive from the same debounced value — input, URL, results, and page-reset stay in sync, just delayed ~120ms together. This avoids the transient desync the spec flagged.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; suite ≥ baseline.

Manual: `npm run dev`. Type a query quickly. Expected: the input echoes keystrokes instantly; results + the URL `?q=` update once typing pauses (~120ms), not per character. Escape still clears instantly; `/` still focuses.

- [ ] **Step 4: Commit**

```bash
git add src/app/_hooks/useDebouncedValue.ts src/app/page.tsx
git commit -m "perf: debounce search filtering + URL sync"
```

---

## Final verification

- [ ] **Full type-check + test suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; pass count ≥ pre-flight baseline.

- [ ] **End-to-end manual pass**

`npm run dev`, then confirm:
- Clicking any filter: no `/api/internships` request, no skeleton flash (Network tab).
- Result counts/order match pre-change behavior across a matrix of filters.
- Applied/Hide toggles update optimistically and survive Refresh.
- Search is smooth; URL `?q=` settles after typing stops.
- Cold load: `curl` of the list endpoint carries no `description` field.

- [ ] **Update memory**

Add a `project_*` memory note recording that filtering is now fully client-side (no source/minScore refetch), the list payload is trimmed via `pickListFields` (allowlist in `src/app/_lib/list-item.ts`), and the pure pipeline lives in `src/app/_lib/filter-pipeline.ts`. Note the deferred follow-ups (consolidate the 3 full-corpus passes; virtualization; server-side pagination beyond ~50k) per the spec.

---

## Notes on deferred work (from spec — do NOT build here)

- **Consolidate the 3 whole-corpus passes** (`filteredExcludingSeasons`, `filtered`, `tabCounts`) — next bottleneck toward 50k; measure first.
- **List virtualization** (react-window) — only if profiling shows DOM render dominates after the above.
- **Server-side pagination** — larger effort touching filtering, tab counts, season counts, and total-page derivation together; not a localized swap.
