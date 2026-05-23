# Filter logic stays inline in page.tsx (for now)

> **Superseded** by [[0005-filter-spec-shared-between-app-and-notifier]].
> The notifier grew its own mirror of this chain; two independent
> implementations drifting on the non-US predicate was the trigger
> that flipped the cost/benefit.

`src/app/page.tsx` has ~180 lines of filter predicates inlined across two `useMemo`s (the main list and `tabCounts`). Extracting a `FilterSpec` value + `applyFilters(postings, spec)` would unlock unit tests for each predicate (location AND-vs-OR, NaN min-score, role OR semantics — all things we currently only verify via Playwright). **Deferred** because the extraction is a focused session on its own, page.tsx is the most-edited file in the repo, and the recent bug-fixes (URL-hydration gate, abort-decoupling, role filter) need to settle before another large refactor in the same file. Revisit when the next non-trivial filter dimension lands, or when a Playwright regression catches a predicate bug that a unit test would have prevented.
