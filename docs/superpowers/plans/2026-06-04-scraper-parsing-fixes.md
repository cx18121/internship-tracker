# Scraper Parsing Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Handshake scraper (corrupted title/company/location from DOM drift), stop the salary parser inventing phantom salaries, repair the prod backlog, and clean up three small per-source parsing defects.

**Architecture:** The Handshake scraper is refactored so the browser context only extracts *raw* per-card signals (aria-label, logo alt, footer text); all field derivation moves to pure, unit-tested Node functions in a new `handshake-parse.ts`. The shared salary parser is hardened (drop the unit-less range pattern, add an "Unpaid" short-circuit) and enrichment now prefers a scraper-provided authoritative salary over description-scraping. Backlog repair is delete-then-rescrape, ordered after deploy.

**Tech Stack:** TypeScript, Node, Playwright (Firefox), Postgres (`pg`), the repo's custom test runner (`src/poller/test.ts`, run via `npm test`, node `assert`).

**Spec:** `docs/superpowers/specs/2026-06-04-scraper-parsing-fixes-design.md`

**Conventions for every task:**
- Tests live in `src/poller/test.ts` using the existing `test(name, fn)` / `assert` idiom — do NOT add a new test framework.
- Run the suite with `npm test`. A passing run ends with `... / ... passed` and no `FAIL` lines.
- Commit after each task.

---

### Task 1: Harden the salary parser (S1)

Remove the noisy unit-less `$X–$Y` pattern and add an "Unpaid"/"Volunteer" short-circuit so unpaid roles never inherit a stray dollar amount.

**Files:**
- Modify: `src/lib/salary.ts:48-51` (remove bare pattern) and `src/lib/salary.ts:57-58` (add short-circuit)
- Test: `src/poller/test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/poller/test.ts` (import `parseSalary` at the top alongside the existing imports: `import { parseSalary } from '../lib/salary';`). Place under a new section header:

```ts
console.log('\n── Salary parser tests ───────────────────────────────────');

test('Unpaid role yields no salary even if description has a $ figure', () => {
  const s = parseSalary('Full Stack Engineering Internship Unpaid. Our platform manages $120,000-$180,000 in assets.');
  assert.strictEqual(s.text, null);
  assert.strictEqual(s.unit, null);
});

test('Bare unit-less $ range is no longer treated as salary', () => {
  // Company revenue / unrelated figure in a description must not become a salary.
  const s = parseSalary('Software Engineer Intern. We raised $50,000-$75,000 in our seed round.');
  assert.strictEqual(s.text, null);
});

test('Anchored hourly range still parses', () => {
  const s = parseSalary('SWE Intern $25-30/hr');
  assert.strictEqual(s.unit, 'hourly');
  assert.strictEqual(s.min, 25);
  assert.strictEqual(s.max, 30);
});

test('Anchored k-suffix yearly range still parses', () => {
  const s = parseSalary('New Grad $120-180k');
  assert.strictEqual(s.unit, 'yearly');
  assert.strictEqual(s.min, 120000);
  assert.strictEqual(s.max, 180000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E 'Salary parser|FAIL'`
Expected: the "Unpaid" and "Bare unit-less" tests FAIL (current code matches the k-suffix `$120-180k` as yearly and the bare `$50,000-$75,000` as yearly).

- [ ] **Step 3: Implement the hardening**

In `src/lib/salary.ts`, delete the bare pattern (lines 48-51, the entry with `unit: null` and its comment):

```ts
  // (removed) Bare $X-$Y unit-less pattern — too noisy; matched unrelated
  // dollar amounts in descriptions (revenue, benefits, other roles' pay).
```

So `PATTERNS` ends after the yearly-single-no-k entry (line 46). The `resolvedUnit`/`!resolvedUnit` block in `parseSalary` (lines 80-84) now never fires (no pattern has `unit: null`) but is harmless; leave it.

Add the unpaid short-circuit at the top of `parseSalary`, right after the `if (!input) return EMPTY;` line:

```ts
export function parseSalary(input: string | null | undefined): Salary {
  if (!input) return EMPTY;
  // Unpaid/volunteer roles must never inherit a stray $ figure from the body.
  if (/\b(unpaid|no\s+compensation|volunteer|pro\s+bono)\b/i.test(input)) return EMPTY;
  const text = input.replace(/\s+/g, ' ');
  ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E 'Salary parser|FAIL'`
Expected: all four Salary parser tests PASS, no FAIL lines.

- [ ] **Step 5: Commit**

```bash
git add src/lib/salary.ts src/poller/test.ts
git commit -m "fix(salary): drop unit-less range pattern, short-circuit unpaid roles"
```

---

### Task 2: Prefer scraper-provided salary in enrichment (S1/S2 root)

Enrichment currently ignores any salary a scraper already knows and always re-parses from `title + description`. Make it forward an authoritative scraper salary when present, and skip description-parsing for Handshake (whose card always states comp — `$…` or `Unpaid`), so unpaid Handshake roles can't get a phantom salary.

**Files:**
- Modify: `src/poller/utils/enrich.ts:30-33` and the salary spread at `:58-63`
- Test: `src/poller/test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/poller/test.ts` (import `enrichForStorage`: `import { enrichForStorage } from './utils/enrich';`):

```ts
console.log('\n── Enrich salary-precedence tests ────────────────────────');

test('Scraper-provided salary is forwarded, not overwritten by description parse', () => {
  const row = enrichForStorage({
    title: 'SWE Intern', company: 'Acme', link: 'https://x.com/a', source: 'Handshake',
    salaryText: '$25/hr', salaryMin: 25, salaryMax: 25, salaryUnit: 'hourly',
    description: 'We manage $200,000-$300,000/yr portfolios.',
  }, '2026-06-04T00:00:00.000Z');
  assert.strictEqual(row.salaryText, '$25/hr');
  assert.strictEqual(row.salaryUnit, 'hourly');
});

test('Handshake row with no scraper salary does not invent one from description', () => {
  const row = enrichForStorage({
    title: 'AI Specialist', company: 'A Free Bird', link: 'https://x.com/b', source: 'Handshake',
    description: 'Stipend pool of $100,000-$150,000/yr shared across the cohort.',
  }, '2026-06-04T00:00:00.000Z');
  assert.strictEqual(row.salaryText, undefined);
});

test('Non-Handshake row still parses salary from description', () => {
  const row = enrichForStorage({
    title: 'SWE Intern $30/hr', company: 'Acme', link: 'https://x.com/c', source: 'Greenhouse',
  }, '2026-06-04T00:00:00.000Z');
  assert.strictEqual(row.salaryUnit, 'hourly');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E 'Enrich salary|FAIL'`
Expected: the first two tests FAIL — current `enrichForStorage` always runs `parseSalary(title+desc)`, so it overwrites `$25/hr` and invents a salary for the unpaid Handshake row.

- [ ] **Step 3: Implement precedence**

In `src/poller/utils/enrich.ts`, replace the salary parse (lines 30-33) with:

```ts
  // Salary precedence: a scraper that reports authoritative comp (e.g.
  // Handshake's card pay token) wins. Handshake always states comp on the
  // card ($… or "Unpaid"), so we NEVER re-parse its description — that's
  // what used to invent salaries for unpaid roles. Other sources fall back
  // to parsing title + description (pre-trim, so a buried pay line survives).
  const salary = p.salaryText
    ? { text: p.salaryText, min: p.salaryMin ?? null, max: p.salaryMax ?? null, unit: p.salaryUnit ?? null }
    : p.source === 'Handshake'
      ? { text: null, min: null, max: null, unit: null }
      : parseSalary(`${p.title || ''} ${p.description || ''}`);
```

The existing spread at the end (lines 58-63) already reads `salary.text`/`salary.min`/etc., so no change there.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E 'Enrich salary|FAIL'`
Expected: all three Enrich salary tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/poller/utils/enrich.ts src/poller/test.ts
git commit -m "fix(enrich): prefer scraper salary; never re-parse Handshake description"
```

---

### Task 3: Pure Handshake card parser (H1/H2/H3)

Extract all field derivation into pure functions so the browser context only scrapes raw strings. This is the core Handshake fix and the only unit-testable seam for it.

**Files:**
- Create: `src/poller/pollers/handshake-parse.ts`
- Test: `src/poller/test.ts`

Raw signals available per card (confirmed via live recon 2026-06-04):
- `logoAlt` — `img[alt]` (clean company; absent on ~12% logoless cards)
- `ariaLabel` — `{Company} {Role} {Pay|Unpaid} · {Type} · {Dates} {Location} {time}`
- `footerText` — `[Promoted∙]{Location}∙{time-ago}` (∙ = U+2219)

- [ ] **Step 1: Write failing tests**

Add to `src/poller/test.ts` (import: `import { deriveCompany, deriveRoleAndComp, deriveLocation } from './pollers/handshake-parse';`):

```ts
console.log('\n── Handshake card parser tests ───────────────────────────');

test('deriveCompany prefers logo alt', () => {
  assert.strictEqual(
    deriveCompany('Goalbound', 'Goalbound Software Engineering Internship $25/hr · Internship · Jun 14—Jul 30 Remote 3d ago'),
    'Goalbound'
  );
});

test('deriveCompany returns null when no logo (caller falls back / drops)', () => {
  assert.strictEqual(deriveCompany('', 'CGTech Software Engineer (UX) Intern $32/hr · Internship · Jun 23—Aug 27 Irvine, CA New'), null);
});

test('deriveRoleAndComp strips company prefix and cuts at pay token', () => {
  const r = deriveRoleAndComp('Goalbound', 'Goalbound Software Engineering Internship $25/hr · Internship · Jun 14—Jul 30 Remote 3d ago');
  assert.strictEqual(r.role, 'Software Engineering Internship');
  assert.strictEqual(r.comp, '$25/hr');
});

test('deriveRoleAndComp handles Unpaid token (comp empty)', () => {
  const r = deriveRoleAndComp('A Free Bird Corporation', 'A Free Bird Corporation AI Specialist Unpaid · Internship Remote 2wk ago');
  assert.strictEqual(r.role, 'AI Specialist');
  assert.strictEqual(r.comp, '');
});

test('deriveRoleAndComp falls back to cut at " · " when no pay/Unpaid token', () => {
  const r = deriveRoleAndComp('Acme', 'Acme Data Intern · Internship · Jun 1—Aug 1 Remote 1d ago');
  assert.strictEqual(r.role, 'Data Intern');
  assert.strictEqual(r.comp, '');
});

test('deriveLocation parses footer, dropping Promoted and time-ago', () => {
  assert.strictEqual(deriveLocation('Promoted∙Melrose, MA∙3wk ago'), 'Melrose, MA');
  assert.strictEqual(deriveLocation('Remote∙3d ago'), 'Remote');
  assert.strictEqual(deriveLocation('Remote or San Jose, CA∙2mo ago'), 'Remote or San Jose, CA');
});

test('deriveLocation returns empty string when footer yields nothing usable', () => {
  assert.strictEqual(deriveLocation('5d ago'), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E 'Handshake card|FAIL'`
Expected: FAIL with module-not-found for `handshake-parse`.

- [ ] **Step 3: Implement the parser**

Create `src/poller/pollers/handshake-parse.ts`:

```ts
// Pure derivation of Handshake job-card fields from RAW scraped signals.
// Kept browser-free and side-effect-free so it is unit-testable; the
// scraper (handshake.ts) collects raw strings in page.evaluate and calls
// these in Node. Anchored to the card structure verified via live recon
// on 2026-06-04:
//   logoAlt   = img[alt]  (clean company; ~12% of cards have no logo)
//   ariaLabel = "{Company} {Role} {Pay|Unpaid} · {Type} · {Dates} {Location} {time}"
//   footer    = "[Promoted∙]{Location}∙{time-ago}"   (∙ = U+2219)

const PAY_TOKEN_RE = /\$\s*[\d,]+(?:\.\d+)?(?:\s*[-–—to]+\s*\$?\s*[\d,]+(?:\.\d+)?)?\s*[kK]?\s*\/?\s*(?:hr|hour|hourly|yr|year|mo|month|K\/yr|K\/mo)?/;
const TIME_AGO_RE = /^\s*(?:new|\d+\s*(?:h|d|wk|mo|yr)\s+ago|promoted)\s*$/i;

/** Company from the logo alt. Returns null when absent — the caller is
 *  responsible for the detail-page fallback and, failing that, dropping the
 *  card (we never store a guessed company). */
export function deriveCompany(logoAlt: string, _ariaLabel: string): string | null {
  const c = (logoAlt || '').trim();
  return c.length > 0 ? c : null;
}

/** Split the aria-label into role + comp token. Strips the known company
 *  prefix, then cuts at the first of: a $-pay token, the word "Unpaid"
 *  (or "Unspecified"), or " · " (the type separator). */
export function deriveRoleAndComp(company: string, ariaLabel: string): { role: string; comp: string } {
  let rest = (ariaLabel || '').trim();
  const co = (company || '').trim();
  if (co && rest.toLowerCase().startsWith(co.toLowerCase())) {
    rest = rest.slice(co.length).trim();
  }
  // Find earliest cut point.
  const payMatch = rest.match(/\$\s*[\d,]/);
  const unpaidMatch = rest.match(/\b(Unpaid|Unspecified)\b/i);
  const sepIdx = rest.indexOf(' · ');
  const candidates = [
    payMatch ? payMatch.index ?? -1 : -1,
    unpaidMatch ? unpaidMatch.index ?? -1 : -1,
    sepIdx,
  ].filter((i) => i >= 0);
  const cut = candidates.length ? Math.min(...candidates) : rest.length;

  const role = rest.slice(0, cut).trim();
  // Comp is the segment between the role and the next " · " (type), if it is
  // a real $ amount; "Unpaid"/empty → no comp.
  const after = rest.slice(cut).trim();
  const beforeSep = after.split(' · ')[0].trim();
  const payInComp = beforeSep.match(PAY_TOKEN_RE);
  const comp = payInComp && /\$/.test(beforeSep) ? payInComp[0].trim() : '';
  return { role, comp };
}

/** Location from the footer hook: split on ∙, drop a leading "Promoted" and
 *  the trailing "<n><unit> ago"/"New", keep the remainder. */
export function deriveLocation(footerText: string): string {
  const parts = (footerText || '')
    .split('∙')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !TIME_AGO_RE.test(s));
  return parts.join(' ').trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E 'Handshake card|FAIL'`
Expected: all Handshake card parser tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/poller/pollers/handshake-parse.ts src/poller/test.ts
git commit -m "feat(handshake): pure card-field parser (company/role/comp/location)"
```

---

### Task 4: Wire the Handshake scraper to raw signals + pure parser

Refactor `scrapeJobsPage` so `page.evaluate` returns raw per-card signals, then derive fields in Node via Task 3. Add the detail-page company fallback for logoless cards and drop cards that still have no company.

**Files:**
- Modify: `src/poller/pollers/handshake.ts:50-149` (card extraction + row build) and `:212-285` (detail-page eval — add employer-name capture)

**PRE-WORK (selector recon — do this first, it gates the fallback):** The detail-page employer-name selector is unknown. Write a throwaway probe `scripts/_hsdetail.mjs` that loads saved auth, opens one `/jobs/{id}` detail page, and dumps candidate employer-name nodes (e.g. `[data-hook*="employer" i]`, headings near the title). Run it, identify the stable selector, then delete the probe. If no stable selector exists, the fallback is "drop the card" and the `companyFromDetail` branch in Step 3 is omitted.

- [ ] **Step 1: Update the in-browser extraction to return raw signals**

In `src/poller/pollers/handshake.ts`, replace the body of `page.evaluate` (lines 50-137, the `const jobs = await page.evaluate(...)` block) so each card returns raw strings only:

```ts
      const rawCards = await page.evaluate(() => {
        const cards = document.querySelectorAll('[data-hook^="job-result-card"]:not([data-hook*="footer"]):not([data-hook*="hide"])');
        return Array.from(cards).map((card) => {
          const hook = card.getAttribute('data-hook') || '';
          const jobId = hook.split('|')[1]?.trim() || '';
          const anchor = card.querySelector('a[aria-label]');
          const ariaLabel = (anchor?.getAttribute('aria-label') || '').replace(/^View\s+/i, '').replace(/^Loading\.*\s*/i, '').trim();
          const href = anchor?.getAttribute('href') || '';
          const link = href
            ? `https://app.joinhandshake.com${href.split('?')[0]}`
            : jobId ? `https://app.joinhandshake.com/job-search/${jobId}` : '';
          const logoAlt = (card.querySelector('img[alt]') as HTMLImageElement | null)?.alt?.trim() || '';
          const footerEl = card.querySelector('[data-hook="job-result-card-footer"]');
          const footerText = (footerEl?.textContent || '').replace(/\s+/g, ' ').trim();
          return { jobId, ariaLabel, link, logoAlt, footerText };
        }).filter((c) => c.jobId && c.ariaLabel);
      });
```

- [ ] **Step 2: Derive fields in Node and build rows**

Replace the row-building loop (the `const now = ...; for (const job of jobs) { ... }` block, lines 139-149) with derivation via the pure parser. Add the import at the top of the file:

```ts
import { deriveCompany, deriveRoleAndComp, deriveLocation } from './handshake-parse';
```

Then:

```ts
      const now = new Date().toISOString();
      let dropped = 0;
      for (const raw of rawCards) {
        const company = deriveCompany(raw.logoAlt, raw.ariaLabel);
        const { role, comp } = deriveRoleAndComp(company ?? '', raw.ariaLabel);
        const location = deriveLocation(raw.footerText);
        if (!company) {
          // No logo → cannot trust a text-split company. Defer to the
          // detail-page fallback (enrichWithDetailLinks) by storing the raw
          // aria-label-derived role with a null company marker; rows that
          // still lack a company after enrichment are dropped there.
          dropped++;
        }
        if (!role) { dropped++; continue; }
        const sal = comp ? parseSalary(comp) : { text: null, min: null, max: null, unit: null };
        const row = buildInternshipRow({
          title: role,
          company: company ?? '',
          location,
          link: raw.link,
          source: 'Handshake',
          seenAt: now,
        });
        if (sal.text) {
          row.salaryText = sal.text;
          row.salaryMin = sal.min ?? undefined;
          row.salaryMax = sal.max ?? undefined;
          row.salaryUnit = sal.unit ?? undefined;
        }
        // Carry the jobId so the detail-page pass can match for company backfill.
        (row as Partial<Internship> & { _jobId?: string })._jobId = raw.jobId;
        results.push(row);
      }
      console.log(`[handshake poller] Page ${pageNum}: ${rawCards.length} cards, ${dropped} need company backfill/drop`);
```

Add `import { parseSalary } from '../../lib/salary';` at the top if not already present.

- [ ] **Step 3: Detail-page company backfill + final drop**

In `enrichWithDetailLinks`, the per-job `page.evaluate` (lines 212-285) already returns `{ externalLink, description, descSelectorHit }`. Add an employer-name read using the selector found in PRE-WORK (example shown; substitute the real selector):

```ts
        // Employer name — only needed when the card had no logo. Selector
        // confirmed via scripts/_hsdetail.mjs recon on 2026-06-04.
        let employerName = '';
        const empEl = document.querySelector('[data-hook="details-page-company-name"]'); // <-- replace with real selector
        if (empEl) employerName = (empEl.textContent || '').replace(/\s+/g, ' ').trim();
```

Return `employerName` from the eval, and after the eval in the `pool` callback:

```ts
      if (!job.company && detail.employerName) {
        job.company = detail.employerName;
      }
```

Finally, after `enrichWithDetailLinks` runs in `pollHandshake` (after line 341), drop any row that still has no company so garbage is never stored:

```ts
    const beforeDrop = results.length;
    const cleaned = results.filter((r) => (r.company || '').trim().length > 0);
    const droppedNoCompany = beforeDrop - cleaned.length;
    if (droppedNoCompany > 0) {
      console.warn(`[handshake poller] Dropped ${droppedNoCompany} card(s) with no resolvable company`);
    }
```

Use `cleaned` in place of `results` for the remainder of `pollHandshake` (the `discoverATSTarget` map and the `return`). Also strip the temporary `_jobId` before returning:

```ts
    cleaned.forEach((r) => { delete (r as Partial<Internship> & { _jobId?: string })._jobId; });
    return cleaned;
```

- [ ] **Step 4: Type-check and run the suite**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: no errors.
Run: `npm test 2>&1 | tail -5`
Expected: suite passes (no new FAILs).

- [ ] **Step 5: Commit**

```bash
git add src/poller/pollers/handshake.ts
git commit -m "fix(handshake): derive fields from raw card signals via pure parser"
```

---

### Task 5: Greenhouse title HTML decoding (G1)

**Files:**
- Modify: `src/poller/pollers/ats.ts:32`
- Test: `src/poller/test.ts`

- [ ] **Step 1: Write failing test**

`ats.ts` builds Greenhouse rows inline inside `pollGreenhouse`; rather than invoke the network, test the chosen primitive directly. Add (import `stripHtml`: `import { stripHtml } from './utils/html';`):

```ts
console.log('\n── HTML decode tests ─────────────────────────────────────');

test('stripHtml decodes entities in a Greenhouse-style title', () => {
  assert.strictEqual(stripHtml('Data Science Intern &#8211; Summer 2026 &amp; Beyond'), 'Data Science Intern – Summer 2026 & Beyond');
});
```

- [ ] **Step 2: Run to verify it passes already (primitive is correct) or fails**

Run: `npm test 2>&1 | grep -E 'HTML decode|FAIL'`
Expected: PASS (this asserts the primitive does what we need). The real change is applying it at line 32.

- [ ] **Step 3: Apply `stripHtml` to the Greenhouse title**

In `src/poller/pollers/ats.ts`, find the Greenhouse row build (around line 32, `title: j.title || ''`) and change to:

```ts
        title: stripHtml(j.title || ''),
```

Confirm `stripHtml` is imported in `ats.ts` (it is used for `j.content`); if not, add the import.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/poller/pollers/ats.ts src/poller/test.ts
git commit -m "fix(greenhouse): decode HTML entities in job titles"
```

---

### Task 6: Lever workplaceType location enum (L1)

Stop surfacing `"onsite"`/`"unspecified"` as a location string.

**Files:**
- Modify: `src/poller/pollers/ats.ts:59`

- [ ] **Step 1: Locate and read the Lever row build**

Run: `grep -n "workplaceType" src/poller/pollers/ats.ts`
Confirm the line is `location: j.categories?.location || j.workplaceType,`.

- [ ] **Step 2: Map the enum**

Replace that line with:

```ts
        // Lever workplaceType is an internal enum ("remote"/"onsite"/"hybrid"/
        // "unspecified"). Only "remote" is a meaningful display location; the
        // rest are not place names, so fall back to empty rather than show
        // "onsite"/"unspecified".
        location: j.categories?.location || (String(j.workplaceType).toLowerCase() === 'remote' ? 'Remote' : ''),
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/poller/pollers/ats.ts
git commit -m "fix(lever): don't use workplaceType enum as a location string"
```

---

### Task 7: Strip emoji badges from SimplifyJobs titles (Si1)

**Files:**
- Modify: `src/poller/pollers/github.ts` (title assignment, ~line 117)
- Test: `src/poller/test.ts`

- [ ] **Step 1: Inspect the existing emoji helper**

Run: `grep -n "EMOJI_STRIP_RE\|stripEmojiPrefix" src/lib/utils/normalize.ts`
Read the regex. It strips emoji globally. We want a title-safe strip that removes emoji glyphs but preserves the text.

- [ ] **Step 2: Write failing test**

Add to `src/poller/test.ts` (import the helper used in Step 3 — if reusing `stripEmojiPrefix`: it is already imported in some modules; import into the test: `import { stripEmojiPrefix } from '../lib/utils/normalize';`):

```ts
console.log('\n── SimplifyJobs title emoji tests ────────────────────────');

test('Emoji badges are stripped from SimplifyJobs titles', () => {
  assert.strictEqual(
    stripEmojiPrefix('Research Intern - SDN Traffic Intelligence & Control 🎓').trim(),
    'Research Intern - SDN Traffic Intelligence & Control'
  );
  assert.strictEqual(stripEmojiPrefix('Software Engineer Intern 🛂🇺🇸').trim(), 'Software Engineer Intern');
});
```

> NOTE: if `stripEmojiPrefix` only strips a *leading* emoji, this test will fail for trailing badges. In that case, in Step 3 use the global `EMOJI_STRIP_RE` directly (it replaces all emoji) instead of `stripEmojiPrefix`, and import that instead.

- [ ] **Step 3: Run to verify, then apply to the title**

Run: `npm test 2>&1 | grep -E 'title emoji|FAIL'`
If the test fails because the helper is prefix-only, switch to the global strip. In `src/poller/pollers/github.ts`, where `title` is assigned (`const title = stripHtml(cells[1]);`), wrap it:

```ts
        const title = stripEmojiPrefix(stripHtml(cells[1])).trim();
```

(Import `stripEmojiPrefix` — or the global `EMOJI_STRIP_RE`-based helper — at the top of `github.ts`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E 'title emoji|FAIL'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/poller/pollers/github.ts src/poller/test.ts
git commit -m "fix(simplify): strip emoji badges from job titles"
```

---

### Task 8: Live verification against Handshake (pre-deploy gate)

Per `feedback_verify_with_live_upstreams` — unit tests miss DOM-integration bugs. Confirm the rewritten scraper produces clean fields on real cards before deploying.

**Files:**
- Create (throwaway): `scripts/_hsverify.mjs`

- [ ] **Step 1: Write the verification probe**

Create `scripts/_hsverify.mjs` that loads saved auth (same setup as the recon probe used during design), scrapes page 1, and for each card prints the DERIVED `{company, role, comp, location}` using the real pure parser:

```js
import { firefox } from 'playwright';
import path from 'path';
import { deriveCompany, deriveRoleAndComp, deriveLocation } from '../src/poller/pollers/handshake-parse.ts';
// ... (load data/handshake-auth.json, navigate to the JOBS_URL, collect the
// same raw {ariaLabel, logoAlt, footerText} per card as handshake.ts Step 1,
// then print derive* output for 25 cards)
```

(Run with `npx tsx scripts/_hsverify.mjs` so the `.ts` import resolves.)

- [ ] **Step 2: Run and inspect**

Run: `npx tsx scripts/_hsverify.mjs 2>&1 | head -60`
Expected: ≥20 cards with a non-empty `company` that is NOT a role/`$`/`"Internship"` string, a `role` with no `$`/`·`/date suffix, and a `location` that is a place or "Remote" (no truncated `"York, NY"`). If a class of card is mis-derived, fix `handshake-parse.ts` and re-run Tasks 3-4 tests.

- [ ] **Step 3: Delete the probe and commit nothing**

```bash
rm -f scripts/_hsverify.mjs
```

(No commit — verification only. Record the observed pass rate in the PR description.)

---

### Task 9: Salary correction migration (non-Handshake frozen values, S2)

`COALESCE(salary_text,…)` froze wrong salaries. Re-run the hardened parser over active rows and correct mismatches. Handshake rows are handled by Task 10 (delete+rescrape), so EXCLUDE them here.

**Files:**
- Create: `scripts/fix-frozen-salaries.ts`

- [ ] **Step 1: Write the migration as measure-only first**

Create `scripts/fix-frozen-salaries.ts` that:
1. Connects via `DATABASE_URL` (mirror `scripts/_audit.mjs` connection setup: `ssl: { rejectUnauthorized: false }`).
2. Selects active, non-Handshake rows with a non-null `salary_text`: `select id, title, description, salary_text, salary_min, salary_max, salary_unit from internships where coalesce(archived,false)=false and source <> 'Handshake' and salary_text is not null`.
3. For each, computes `parseSalary(\`${title} ${description ?? ''}\`)` (import from `../src/lib/salary`).
4. Flags a row as needing correction when `new.text !== salary_text` (including new.text === null, meaning the frozen value should be cleared — e.g. unpaid).
5. Accepts a `--apply` flag. WITHOUT it, only prints the count and the first 30 `{id, old, new}` diffs. WITH it, runs `UPDATE internships SET salary_text=$2, salary_min=$3, salary_max=$4, salary_unit=$5 WHERE id=$1` per flagged row inside a transaction.

- [ ] **Step 2: Measure (dry run)**

Run: `npx tsx scripts/fix-frozen-salaries.ts 2>&1 | head -40`
Expected: a count and a sample of diffs. **Manually review the sample** — confirm the corrections are removing phantom salaries / fixing wrong ones, not destroying legitimate ones. If the sample looks wrong, STOP and revisit Task 1's regex.

- [ ] **Step 3: Apply, then prove the fixpoint invariant**

Run: `npx tsx scripts/fix-frozen-salaries.ts --apply 2>&1 | tail -5`
Then run the dry run again: `npx tsx scripts/fix-frozen-salaries.ts 2>&1 | head -3`
Expected: second dry run reports **0 rows needing correction** (idempotent fixpoint — per `feedback_prove_migrations_with_invariants`). If non-zero, the parser is non-deterministic on some input; investigate before proceeding.

- [ ] **Step 4: Commit the script**

```bash
git add scripts/fix-frozen-salaries.ts
git commit -m "chore(migration): correct frozen-wrong salaries on non-Handshake rows"
```

> RUN-ORDER NOTE: this migration is executed AFTER deploy (it depends on the hardened parser being the one of record). Do not run against prod until the code change is deployed.

---

### Task 10: Handshake backlog delete + re-scrape

Repair the ~143 corrupted prod rows by deleting them (DELETE, not archive — avoids resurrection per `project_company_canonicalization`) and letting the fixed poller re-insert clean rows.

**Files:**
- Create: `scripts/repair-handshake-backlog.ts`

- [ ] **Step 1: Write the delete script (measure-only first)**

Create `scripts/repair-handshake-backlog.ts` that:
1. Connects via `DATABASE_URL`.
2. Selects corrupted Handshake rows using the audit detectors:
   `select id, company, title from internships where source='Handshake' and coalesce(archived,false)=false and (title ~ '· ?Internship' or title ~ '\\d+(wk|d|mo|h|yr) ago' or title ~ '/(hr|yr|mo) · ' or title ~ 'Unpaid ·' or company='Internship' or company ~ '/hr' or company ~ 'Intern\\$' or length(company) > 45)`.
3. Without `--apply`: print the count + first 30 rows.
4. With `--apply`: `DELETE FROM internships WHERE id = ANY($1)` for the matched ids, in a transaction. Print deleted count.

- [ ] **Step 2: Measure**

Run: `npx tsx scripts/repair-handshake-backlog.ts 2>&1 | head -40`
Expected: ~143 rows (matches the audit). Eyeball that the sample is genuinely corrupted (card-dump titles / garbage company), not false positives.

- [ ] **Step 3: Delete**

Run: `npx tsx scripts/repair-handshake-backlog.ts --apply 2>&1 | tail -3`
Expected: "Deleted N rows" where N ≈ the measured count.

- [ ] **Step 4: Trigger a Handshake poll and re-audit**

Re-run the Handshake poller (the project's normal poll entrypoint, e.g. the agent/poll command) so still-listed jobs re-insert cleanly. Then re-run the audit harness:

Recreate the audit probe (the design-time `scripts/_audit.mjs`, or a trimmed Handshake-only version) and run:
`node scripts/_audit.mjs 2>&1 | sed -n '/Handshake/,/====/p'`
Expected: `title:card-dump` and `company:has-$`/`="Internship"` counts drop to ~0. `loc:truncated-city` near 0. Some aged-out rows simply gone.

- [ ] **Step 5: Commit the script, clean up probes**

```bash
rm -f scripts/_audit.mjs
git add scripts/repair-handshake-backlog.ts
git commit -m "chore(migration): delete corrupted Handshake rows for clean re-scrape"
```

---

### Task 11: Finalize

- [ ] **Step 1: Full suite + type-check**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -3`
Expected: no type errors; all tests pass.

- [ ] **Step 2: Confirm no stray probe scripts remain**

Run: `ls scripts/_*.mjs 2>/dev/null || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Open PR**

```bash
git push -u origin fix/scraper-parsing
gh pr create --fill --title "Fix scraper parsing: Handshake rewrite + salary hardening + tier-3"
```

Include in the PR body: the before/after audit counts, the live-verification pass rate from Task 8, and the migration fixpoint confirmation from Task 9.

---

## Self-Review

**Spec coverage:**
- H1/H2/H3 (Handshake title/company/location) → Tasks 3, 4, 8. ✓
- S1 (salary regex) → Task 1. ✓
- S2 (frozen value / COALESCE) → Task 2 (forward authoritative salary, skip Handshake re-parse) + Task 9 (correct existing non-Handshake values). ✓
- G1 (Greenhouse decode) → Task 5. ✓
- L1 (Lever location) → Task 6. ✓
- Si1 (SimplifyJobs emoji) → Task 7. ✓
- Backlog delete+rescrape → Task 10. ✓
- Deploy-before-migrate ordering → noted in Tasks 9 and 10. ✓
- Verification (live upstream + invariants) → Tasks 8, 9. ✓

**Open items deliberately left for the implementer (flagged, not hidden):**
- Task 4 detail-page employer selector — explicit PRE-WORK recon step; fallback is "drop card" if none.
- Task 7 emoji helper may be prefix-only — explicit branch to switch to the global strip.

**Type consistency:** `deriveCompany`/`deriveRoleAndComp`/`deriveLocation` signatures match between Task 3 (definition), Task 4 (usage), and Task 8 (probe). `parseSalary` return shape (`{text,min,max,unit}`) used consistently in Tasks 1, 2, 4, 9. The temporary `_jobId` carrier is added in Task 4 Step 2 and removed in Task 4 Step 3.
