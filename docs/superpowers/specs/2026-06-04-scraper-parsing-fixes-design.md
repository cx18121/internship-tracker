# Scraper Parsing Fixes — Design

**Date:** 2026-06-04
**Status:** Approved (design) — pending implementation plan
**Trigger:** List UI showing garbage rows (company `"Internship"`, titles that are full
job-card dumps like `"CGTech Software Engineer (UX) Intern $32/hr · Internship · Jun 23—Aug 27 …"`).

## Problem & Evidence

The user reported that "parsing overall for everything still needs work." A data-grounded
audit (DB probe of all 5 003 active prod rows + per-scraper code review) localized the
real defects:

- **Handshake is the epicenter.** Its job-card DOM drifted; the scraper is anchored to the
  old structure. Of 723 active Handshake rows: **143 (20%)** have a full card-dump in
  `title`, **~32** have a garbage `company` (`"Internship"`, `"CGTechSoftware Engineer (UX) Intern$32/hr"`),
  and location is frequently truncated (`"York, NY"` ← "New York, NY") or over-defaulted to
  `"United States"` (159 rows).
- **A cross-source salary bug** corrupts salaries on *every* source: a too-loose regex grabs
  unrelated dollar amounts from descriptions, and a `COALESCE` write freezes the first
  (possibly wrong) salary forever.
- **Three small, real defects** in other scrapers (Greenhouse title encoding, Lever location
  enum, SimplifyJobs emoji badges in title).

Other sources (Indeed, Ashby, SmartRecruiters, Workday, Google, YC WaaS, Greenhouse, Lever
core fields) are otherwise clean. `title-starts-with-company` hits on Indeed/SimplifyJobs are
**legitimate** employer-written titles and are left alone.

## Goals

1. Fix the Handshake scraper so `company`, `title`, and `location` are extracted from
   reliable current-DOM nodes.
2. Repair the ~143 corrupted Handshake rows already in prod (delete + re-scrape).
3. Harden the shared salary parser so it stops inventing salaries, and correct existing
   frozen-wrong salaries.
4. Fix three small parsing defects (Greenhouse decode, Lever location, SimplifyJobs emoji).

## Non-Goals (explicit — deferred, not forgotten)

- SmartRecruiters / Workday-Playwright pagination caps (coverage, not parsing).
- LinkedIn blank locations (upstream JobSpy library `_get_location`; would need a
  search-query fallback — separate change).
- iCIMS hardcoded `"United States"` location (known limitation; needs new HTML extraction).
- Ashby `};` SSR-regex truncation (speculative, unverified — file as a watch item).
- `ats-targets.json` slug casing/encoding (config quality, not parsing).
- Ripping out the deliberate `COALESCE` backfill semantics in `store.ts` (it intentionally
  preserves link-upgraded / richer data). We correct bad data with a one-shot migration
  instead.

## Findings Catalog (verified)

| # | Source | File:line | Defect | Fix tier |
|---|--------|-----------|--------|----------|
| H1 | Handshake | `handshake.ts:60` | `title` = full aria-label card dump | 1 |
| H2 | Handshake | `handshake.ts:89–114` | `company` fallback grabs garbage when logo missing | 1 |
| H3 | Handshake | `handshake.ts:123–133` | location regex truncates multi-word cities / over-defaults | 1 |
| S1 | shared | `salary.ts:50` | bare `$X–$Y` pattern has no unit anchor → matches any description dollar range | 2 |
| S2 | shared | `store.ts:366–369` | `COALESCE(salary_text,…)` freezes first (wrong) salary permanently | 2 |
| G1 | Greenhouse | `ats.ts:32` | `j.title` stored without entity decode (`&amp;`, `&#8211;`) | 3 |
| L1 | Lever | `ats.ts:59` | `j.workplaceType` enum (`"onsite"`/`"unspecified"`) used as location string | 3 |
| Si1 | SimplifyJobs | `github.ts:117` | emoji badges (`🎓🛂🇺🇸` — encode visa/citizenship) stored verbatim in `title` | 3 |

## Design

### Tier 1 — Handshake scraper rewrite (`src/poller/pollers/handshake.ts`)

Live-DOM recon (2026-06-04, saved-auth probe over 6 current cards) established the reliable
nodes. Each card exposes:

- `img[alt]` → clean company (`"Goalbound"`, `"Fenix Commerce Inc"`, …), present on the
  large majority of cards.
- anchor `aria-label` → `{Company} {Role} {Pay|Unpaid} · {Type} · {Dates} {Location} {time}`
  (space-separated).
- `[data-hook="job-result-card-footer"]` → `[Promoted∙]{Location}∙{time-ago}`
  (∙ = U+2219).

**company** (replaces lines 89–114):
1. `img[alt]` (primary).
2. If absent (~12% logoless cards): the employer name from the **detail page** we already
   load in `enrichWithDetailLinks` — no extra page loads.
   *Open item for implementation:* the exact detail-page selector for employer name must be
   confirmed with the same recon probe before coding; do not guess.
3. If both fail: **drop the row** and increment a logged counter. Dropping a handful of
   logoless cards is correct; storing `"Internship"` is not. (Fail loud, not silent garbage.)
   Delete the broken span-walk and the `parts[0]` / `"Unknown"` heuristics entirely.

**title / role** (replaces line 60):
- Start from `aria-label`, strip the leading company string (when known), then truncate at
  the first occurrence of: a `$`-pay token, the word `Unpaid`, or ` · `.
  `"Goalbound Software Engineering Internship $25/hr · …"` → `"Software Engineering Internship"`.

**location** (replaces lines 123–133):
- Parse the footer hook: split on `∙`, drop a leading `"Promoted"`, drop a trailing
  `"<n><unit> ago"` token, keep the remainder (`"Remote or San Jose, CA"`, `"Melrose, MA"`).
- Retire the regex. This fixes both truncated cities and a large share of the
  `"United States"` over-defaults. Fall back to `"United States"` only when the footer
  yields nothing.

### Tier 2 — Salary parser

**S1 (`src/lib/salary.ts`):** the bare unit-less `$X–$Y` range pattern is the root of phantom
salaries. Harden by either (a) removing the unit-less pattern entirely (require an explicit
`/hr`,`/yr`,`/mo`,`k` or `per …` anchor), or (b) keeping it but only honoring it when the
source text has no "Unpaid"/"No compensation" signal AND no competing anchored match.
Decision in the plan; preference is (a) — anchored-only — as the simplest correct rule.
Add an explicit **"Unpaid" / "Volunteer" short-circuit**: if the title/listing says unpaid,
return no salary regardless of stray description numbers.

**S2 (`src/lib/store.ts`):** leave the `COALESCE` backfill semantics intact (deliberate).
Correct existing frozen-wrong salaries with a **one-shot migration** that re-runs the
hardened `parseSalary` over active rows and `UPDATE`s `salary_text/min/max/unit` where the
new result differs — in particular clearing salaries on rows whose title signals "Unpaid".
Measure first (count affected rows); prove safety with an invariant (re-running the migration
is a fixpoint — second run updates 0 rows). See `[[feedback_prove_migrations_with_invariants]]`.

### Tier 3 — small fixes

- **G1 (`ats.ts:32`):** `title: stripHtml(j.title || '')` (already imported; handles entities
  + tags). Verify it doesn't strip legitimate text.
- **L1 (`ats.ts:59`):** map Lever `workplaceType`: `"remote"` → `"Remote"`, otherwise treat
  the enum as "no location" (empty) rather than surfacing `"onsite"`/`"unspecified"`.
- **Si1 (`github.ts`):** strip trailing/embedded emoji badges from the title cell (mirror the
  existing `stripEmojiPrefix` used for company). Keeping the structured visa/citizenship
  meaning is out of scope; the goal here is just to stop storing the glyphs as title noise.

### Backlog repair — delete + re-scrape

Chosen over in-place re-parse because the rewritten scraper's `img[alt]` company is more
reliable than any text-split of the stored dump, and aged-out stale rows disappearing is
acceptable. Mechanism:

1. Ship the fixed scraper + salary fixes first (**deploy-before-migrate**, per
   `[[project_company_canonicalization]]` gotcha).
2. Identify corrupted Handshake rows by the same detectors used in the audit
   (`title ~ '· ?Internship'` / `'/hr · '` / `'<n> ago'` / `'Unpaid ·'`, or garbage company).
   Snapshot the count and a sample first.
3. **DELETE** them (not archive — archiving risks resurrection, per
   `[[project_company_canonicalization]]`).
4. Trigger a Handshake poll; still-listed jobs re-insert clean (fresh insert → hardened
   salary parse applies). Aged-out rows stay gone.
5. Re-run the audit harness; confirm corrupted-row count → ~0 and no new garbage.

## Testing & Verification

- **Unit tests:** salary parser — "Unpaid" short-circuit, unit-less range no longer matches a
  description revenue figure, anchored ranges still parse. Handshake field extraction — feed
  representative `aria-label` + footer strings, assert clean company/role/location split
  (company-prefix strip, pay/`·`/Unpaid truncation, footer Promoted/`ago` stripping).
- **Live verification:** re-run the recon probe against live Handshake; confirm the new
  extraction yields clean fields on ≥20 cards (per `[[feedback_verify_with_live_upstreams]]`).
- **Backlog:** before/after audit-harness counts; migration fixpoint invariant.
- **Tier 3:** spot-check Greenhouse entity titles, a Lever blank-location row, a SimplifyJobs
  emoji-badge row post-fix.

## Rollout Order

1. Land scraper + salary + Tier-3 code changes; unit tests green; live probe confirms.
2. Deploy.
3. Run salary-correction migration (measured, invariant-checked).
4. Run Handshake delete + trigger poll; re-audit.

## Risks

- **Detail-page employer selector unknown** → mitigated by probing before coding; logoless
  cards drop rather than store garbage if it can't be found.
- **Salary migration over-corrects** a legitimate salary → mitigated by measure-first +
  manual sample review + fixpoint invariant; only clear/replace where the hardened parser
  disagrees.
- **Handshake re-drift** in future → the footer/img-alt/aria-label anchors are more stable
  than span-walks, and the recon probe is preserved as a re-runnable diagnostic.
