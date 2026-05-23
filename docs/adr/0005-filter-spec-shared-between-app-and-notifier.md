# Filter spec is shared between app table and notifier push gate

Supersedes [[0002-filter-logic-stays-inline-in-page-tsx]].

The two filter chains — `src/app/page.tsx`'s inline `.filter()` chain
(applied to the main list and the tab-count loop) and the notifier's
`passesNotifFilters` — had grown to roughly the same 8 predicates:
tier, seasons, applied state, hidden, source include/exclude, keyword
include/exclude, roles. When ADR-0002 was written only the app side
had this chain, so deferring extraction (to avoid churning the
most-edited file in the repo) was the right call. The notifier's
mirror flipped the cost/benefit — two independent implementations of
the same predicate set already drift on at least one dimension (the
notifier uses the structured `classifyLocation` for non-US filtering;
the app uses a substring match).

`src/lib/filter-spec.ts` now owns the shared predicates. `FilterSpec`
declares each as an optional field; `applyFilterSpec(posting, spec)`
runs only the predicates the caller filled in. The parameter type is
a structural `FilterablePosting` so both the storage-side `Internship`
(`src/lib/types.ts`) and the wire-side variant (`src/app/_lib/types.ts`)
satisfy it without coupling the two type files.

Two predicates stayed inline at their respective call sites: the app's
free-text search + substring location (not used by the notifier) and
the notifier's `excludeNonUS` (uses `classifyLocation` from
`src/poller/iso-locations.ts`, which lives in the server-only tree).
Promoting the location classifier into the shared spec would mean
moving `iso-locations.ts` out of `src/poller/` — deferred until the
frontend genuinely wants structured location filtering.
