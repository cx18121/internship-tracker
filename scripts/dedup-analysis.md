# Dedup Analysis — SimplifyJobs Greenhouse/Lever/Ashby

## Summary

**CONFIRMED BUG**: The MD5 hash dedup uses the full URL including UTM params, causing valid postings to be re-imported across poll cycles instead of being deduplicated.

---

## Findings

### Deduplication Structure

The scraper generates an ID via:
```
id = md5(company + title + link)
```
where `link` is the full URL as scraped, **including UTM query params** from the SimplifyJobs aggregator.

At ingest time (`deduplicateAndStore` in `store.ts`):
1. `seen` = Set of all IDs ever stored (loaded from `data/seen.json`)
2. Incoming postings: if `id` is already in `seen`, skip
3. Secondary dedup by `seenLinks` (normalized to full link string — also UTM-affected)

**Problem**: When the same job board URL appears with different UTM params (e.g., `?utm_source=Simplify&ref=Simplify` vs clean URL), it gets a **different MD5 hash** and is stored as a new record instead of being skipped.

---

## Hard Numbers

| Metric | Value |
|--------|-------|
| `internships` table rows | 4809 |
| `seen_ids` table rows | 5238 (429 orphaned — gap from prior crash/migration) |
| `seen.json` IDs | 6360 |
| Internships with UTM params | 1162 (24.2% of DB) |
| Normalized collisions (2000-row sample) | 12 — same posting stored with 2 different IDs |
| Potentially duped company+title combos | 20 (Amazon alone has 70 rows for the same SDE Intern on Indeed) |

### Normalized Dedup Test (2000 rows sampled)

Stripping UTM params before hashing reveals collisions:

| Company | Title | Link1 (stored) | Link2 (new) | ID1 | ID2 |
|---------|-------|-----------------|-------------|-----|-----|
| Verkada | Industrial Design Intern | `.../jobs/5070008007?utm_source=Simplify&ref=Simplify` | `.../jobs/5070008007` (clean) | `2f71e86d...` | `9675fcf2...` |
| Elevations Credit Union | Application Development Intern | `...?utm_source=Simplify&ref=Simplify` | clean | `643f5ce8...` | `4387f912...` |
| Udemy | Front End Software Engineer Intern | `...?utm_source=Simplify&ref=Simplify` | clean | `5eb0afb1...` | `95fc445a...` |

**12 collisions in 2000 rows** — at scale (~4800 rows), this likely means **hundreds of duplicate records** for the same posting with different UTM param variants.

### UTM Source Breakdown

| Source | Count |
|--------|-------|
| SimplifyJobs | 1093 |
| Google | 50 |
| Greenhouse | 18 |
| Workday | 1 |

SimplifyJobs is the primary source of UTM-tagged links, and it's also the main Greenhouse/Lever/Ashby discovery mechanism.

---

## Impact

- **Inflated counts**: same posting appears multiple times with different IDs
- **Missed opportunities**: UI shows duplicates, real new postings may be buried
- **Inflated `seen_ids` table**: 429 orphaned entries from the crash migration

---

## Fix Recommendation

Normalize the link before hashing in `src/agent.ts`:

```typescript
import { URL } from 'url';

function stripTracking(link: string): string {
  try {
    const url = new URL(link);
    const params = new URLSearchParams(url.search);
    const trackingKeys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ref','nl'];
    for (const key of trackingKeys) params.delete(key);
    const normalized = params.toString() ? `${url.origin}${url.pathname}?${params.toString()}` : `${url.origin}${url.pathname}`;
    return normalized;
  } catch { return link; }
}
```

Then use it:
```typescript
const id = md5(`${p.company || ''}${p.title || ''}${stripTracking(p.link || '')}`);
```

**Migration**: After fixing the ID generation, run a dedup pass that groups records by `(company, title, stripTracking(link))` and collapses duplicates, keeping the record with the highest score.

---

## Why It Wasn't Caught Sooner

The secondary dedup (`seenLinks` Set in `deduplicateAndStore`) uses the full `link` string — so if the same URL (with identical UTM params) came in twice, it would be caught. But different UTM variants of the same base URL bypass both dedup layers.

The `seen.json` file grows because each UTM variant gets a unique ID and is added to `seen`, permanently marking it as "seen" even though it's the same posting.

---

## Related: seen_ids vs internships mismatch

`seen_ids` (5238) > `internships` (4809) by 429 entries. This is a leftover from a crash that corrupted `internships.json` but not `seen.json`. The store's reconciliation logic handles new crashes, but the historical gap remains.