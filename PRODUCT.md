# Product

## Register

product

## Users

Charlie, a CS student actively hunting for SWE / ML internships. Single user. Uses the tool many times per day from a laptop browser, often at night, often quickly between other tasks. Comes in with a question ("anything new and interesting today?" / "show me the top scoring postings this week" / "did Anthropic post anything?") and wants an answer in under five seconds without UI ceremony.

Context: he built this for himself because LinkedIn/Indeed/Handshake each leak too much signal and waste too much time. The tool is his unfair advantage — it pulls from a dozen sources, scores everything against his preferences, dedupes across sources, and surfaces postings he'd otherwise miss.

## Product Purpose

A personal internship tracker that aggregates SWE/ML internship postings across many sources (SimplifyJobs, JobSpy → Linkedin/Indeed, Greenhouse/Lever/Ashby/Workday ATS APIs, Handshake, YC WaaS), scores each posting against Charlie's preferences (role keywords, tech stack, company tiers, salary), and lets him triage them fast.

Success is measured by:
- Time-to-first-relevant-posting (how long does opening the page take to "I see something worth applying to")
- Apply-rate on surfaced postings (signal he trusts the scoring)
- Catch-rate on postings he applies to elsewhere (signal coverage is real)

## Brand Personality

Operator-grade, quiet, opinionated. Three words: **dense, restrained, precise.**

Voice: terse and direct. No marketing copy, no exclamation marks, no helper text explaining what's obvious from the UI. Labels are nouns. Status messages state a fact.

Emotionally: feels like a tool a senior engineer built for themselves, not a SaaS product. Closer to Raycast or `htop` than to a recruiter's dashboard. Confidence is shown through information density done well — not by stripping detail to look "clean".

## Anti-references

- **LinkedIn / Indeed.** Crowded enterprise feel, blue-trust palette, competing CTAs, ads woven into the feed, sponsored postings indistinguishable from organic. Everything here is anti-that.
- **Generic AI-SaaS templates.** Gradient hero, the hero-metric card row, purple/blue gradient buttons, "Powered by AI" badges, oversized rounded corners. Identical-card grid syndrome.
- **Naked spreadsheets.** Just an HTML table dumped on the page with no rhythm, no typography craft, no information hierarchy. The data is sortable but unreadable.
- **Notion / Airtable maximalist.** Every option visible at once, six toolbars stacked, configuration leaking into the read view. Optionality theater.

## Design Principles

1. **Postings are the page.** Everything else (header, status, filters, source health) lives in the chrome around the data and gets demoted whenever it competes for attention. If you scroll and don't see a posting within the first viewport, the layout is failing.

2. **Density with rhythm.** This is an operator console, not a calm workspace — show a lot in a small space. But information density only works if there's typographic and spatial rhythm: deliberate scale jumps, varied weights, consistent vertical cadence. Crowded ≠ dense; crowded is just dense done badly.

3. **One canonical answer per concept.** "Posted date" and "Newest" both exist today and mean almost the same thing. Pick the meaningful one, kill the other. Every filter, every sort option, every status line has to justify its existence — if two answers point at the same question, merge them.

4. **Time is a first-class axis.** Charlie's mental model is "what's new since I last looked" and "what's the best stuff from the last week" — not "all 1796 active postings sorted by score". Time windows belong as a primary filter, not buried in sort metadata.

5. **Diagnostic info hides until needed.** Source health, last-polled timestamps, error states, dedup counts — these are real but they're operator-introspection, not job-hunt-execution. They live behind a status indicator that expands on click, not in the main visual hierarchy.

## Accessibility & Inclusion

Single-user tool, so generalized WCAG isn't the bar. Practical bar:
- All text legible on the dark background — body text at least `text-white/70` over the standard `#0a0a0a`-ish background, never `text-white/30` for anything semantic.
- Color is never the only signal. Score labels, applied state, source — all carry text or icon, not just hue.
- Keyboard reachability for the core triage loop: open → filter → mark applied → open next. This isn't a strict a11y requirement for one user, but it's the operator-grade thing to do.
- Respects `prefers-reduced-motion` for any decorative motion that gets added.
