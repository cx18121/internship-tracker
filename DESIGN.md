# Design

## Visual theme

Dark operator console. Surface is near-black with a faint blue cast (`oklch(0.13 0.005 260)`) — not pure black. Type sits high-contrast over it; every other element is tinted with low chroma toward the same hue so the whole UI feels of-a-piece rather than wet-on-dry.

The mood is **3am desk, dim room, single monitor, focused work**. That scene forces the answer: dark, low chroma, generous-but-disciplined whitespace, every UI element earning its presence. The aesthetic neighbors are Raycast's compact-command-bar density, Linear's typographic precision, Vercel's quiet dark dashboard — three references the user named directly.

## Color palette

Strategy: **restrained**. Tinted neutrals do all the structural work; one semantic palette for status (success/warning/danger/info), one for source attribution chips, one for score-label badges. No general-purpose "accent" color — meaning carries the color, not decoration.

### Surfaces (OKLCH, dark)

| Token | Value | Use |
|---|---|---|
| `--surface-base` | `oklch(0.13 0.005 260)` | Page background. Faint blue cast keeps neutrals from looking dead. |
| `--surface-raised` | `oklch(0.18 0.005 260)` | Cards, panels, dropdowns. One step up. |
| `--surface-sunken` | `oklch(0.10 0.005 260)` | Sidebar rail, footers, anything that should recede behind the base layer. |
| `--surface-hover` | `oklch(0.22 0.006 260)` | Hover/focus surface on raised elements. |

### Text

| Token | Value | Use |
|---|---|---|
| `--fg-primary` | `oklch(0.985 0.002 260)` | Headings, posting titles, key metrics. |
| `--fg-secondary` | `oklch(0.78 0.008 260)` | Body, labels, descriptions. |
| `--fg-muted` | `oklch(0.58 0.01 260)` | Timestamps, metadata, axis labels. |
| `--fg-faint` | `oklch(0.42 0.01 260)` | Placeholders, disabled, "—" state. Floor for legibility. |

Never use values below `0.42` lightness for anything semantic. `text-white/30` and below in current code is too dim and should be replaced with `--fg-faint`.

### Borders & dividers

| Token | Value | Use |
|---|---|---|
| `--border-subtle` | `oklch(1 0.005 260 / 8%)` | Default hairline border on raised surfaces. |
| `--border-strong` | `oklch(1 0.005 260 / 18%)` | Active/selected state, focused inputs. |
| `--border-vivid` | `oklch(1 0.005 260 / 30%)` | Used sparingly — currently-selected filter chip, primary action. |

### Status / score palette

Used for score labels, source health states, applied state. Each color sits at lightness ~0.72 (mid-light against dark surfaces) with chroma 0.13–0.16. Background variants use the same hue at lightness ~0.20 with low chroma for the tint.

| Role | Hue | Fg example | Bg example |
|---|---|---|---|
| Elite / top score | 280° (violet) | `oklch(0.78 0.13 280)` | `oklch(0.20 0.04 280)` |
| Strong | 145° (green) | `oklch(0.78 0.14 145)` | `oklch(0.20 0.04 145)` |
| Notable | 220° (blue) | `oklch(0.78 0.13 220)` | `oklch(0.20 0.04 220)` |
| Noise | — | `--fg-muted` | `--surface-raised` |
| Warning (stale, quiet) | 70° (amber) | `oklch(0.78 0.14 70)` | `oklch(0.20 0.04 70)` |
| Danger (source down) | 25° (red) | `oklch(0.72 0.15 25)` | `oklch(0.20 0.04 25)` |
| Salary present | 165° (teal) | `oklch(0.78 0.14 165)` | `oklch(0.20 0.04 165)` |

Source-attribution dots use the existing `SOURCE_DOT` map (one solid color per source) — small enough that variation reads as identification, not noise.

## Typography

System sans by default. Geist is loaded but not strictly required — the goal is a tight neutral grotesque, not a brand-distinctive face. Mono used for IDs, timestamps in the operator drawer, and tabular numbers.

### Scale

| Step | Size | Weight | Line height | Letter-spacing | Use |
|---|---|---|---|---|---|
| `display` | 22px | 600 | 1.15 | -0.02em | App title (rare, header only) |
| `h1` | 16px | 600 | 1.25 | -0.015em | Section labels in chrome |
| `body-strong` | 14px | 600 | 1.35 | -0.01em | Posting title, company name |
| `body` | 14px | 400 | 1.5 | -0.005em | Posting description, default text |
| `caption` | 12px | 500 | 1.4 | 0 | Filter labels, metadata |
| `eyebrow` | 10px | 600 | 1.2 | 0.08em uppercase | Section eyebrows, badge labels |
| `tabular` | 12px | 500 | 1 | 0 | Numeric columns, dates (uses `font-variant-numeric: tabular-nums`) |

Scale ratio ~1.25 between adjacent steps; weight jumps (400 → 600) carry hierarchy without needing more sizes.

### Fonts

- `--font-sans`: Geist (loaded via Next), falls back to `ui-sans-serif, system-ui, -apple-system, sans-serif`.
- `--font-mono`: Geist Mono, falls back to `ui-monospace, "SF Mono", Menlo, monospace`.
- Base body: `font-size: 14px; line-height: 1.5; letter-spacing: -0.005em` — tighter than current 15px/1.6 for more density at the same visual comfort.

## Spacing

Use a `4px` base unit with deliberate jumps (avoid 4-everywhere). Aliases: `--space-1` = 4, `--space-2` = 8, `--space-3` = 12, `--space-4` = 16, `--space-5` = 24, `--space-6` = 32, `--space-8` = 48.

- Inside a single posting row: `--space-2` between adjacent inline elements; `--space-3` between row and row.
- Between filter sections in the rail: `--space-5`.
- Between the rail and the main content: `--space-6`.
- Header to first content row: `--space-4`.
- Avoid uniform padding everywhere — pages should breathe asymmetrically (more space at the top of a section than between rows, more space on the outside edge of the rail than between filter chips).

## Radii

Four-step scale, sharper than the current shadcn default. Operator consoles look more precise with smaller radii.

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | Inputs, chips, small badges |
| `--radius-md` | 6px | Buttons, dropdowns, filter chips |
| `--radius-lg` | 8px | Cards, panels, posting rows |
| `--radius-xl` | 12px | Modals, source-health drawer |

No fully-rounded pills anywhere — too SaaS-cute.

## Elevation

Almost everything sits flat on its surface. Elevation is communicated by surface lightness step, not box-shadow. Two exceptions:
- Dropdowns / popovers / modals: `box-shadow: 0 8px 24px oklch(0 0 0 / 50%)` over a `--surface-raised` panel.
- Sticky elements while user is scrolling past content: subtle bottom border in `--border-strong`, no shadow.

No card shadows in the listing grid. Border is enough.

## Components

### Filter chip

```
[unselected]    bg-transparent  border: 1px var(--border-subtle)   color: var(--fg-secondary)
[hover]         bg: var(--surface-hover)  border: 1px var(--border-strong)
[selected]      bg: var(--surface-raised)  border: 1px var(--border-vivid)  color: var(--fg-primary)
```

Padding `4px 10px`, `--radius-md`, `caption` typography. Hit target stays comfortable despite small visual height.

### Posting row (dense list view)

Grid layout, single line per posting, fixed column template across the viewport so columns align visually. Score badge first, company + title taking the middle, location + season + posted-date trailing, actions on the right. Hover lifts the row one surface step. Applied rows drop to `opacity: 0.5`.

### Posting card (when needed)

Used for the user's flagged / starred postings or in a single-column "scratchpad" mode. Two-column grid otherwise (`grid-cols-2`) on `xl:` and up, single column below `lg:`. Internal anatomy: top row (company/title + score badge), meta row (location/source/salary chips), keyword chips, action row. Border `--border-subtle`, no shadow.

### Status pill (header)

Replaces the current multi-line status bar. Single compact pill in the header showing total · last polled · sources. Click expands a popover with full source health (currently a top-of-page panel). Health state changes the pill color (`--fg-secondary` → `--fg-warning` → `--fg-danger`).

### Filter rail

Left-aligned column, 240–280px wide, `--surface-sunken`, sticky. Sections separated by `--space-5` whitespace, no dividers. Each section: eyebrow label + control. Active filter count appears next to "Filters" header in the rail top.

### Time-window picker

New component. Inline segmented control inside the main content area's top toolbar: `All time · 24h · 3d · Week · Month · 3 months`. Selected state uses `--border-vivid`. Pairs with sort to express "top scores this week" type queries.

## Layout

### Page shell

Two-column desktop, single-column mobile.

```
┌────────────────────────────────────────────────────────────────┐
│ HEADER (one row, ~48px tall): title · status pill · view · ↻ 🔔│
├────────┬───────────────────────────────────────────────────────┤
│        │ CONTROLS BAR: Applied tabs · Time window · Sort · count │
│        ├───────────────────────────────────────────────────────┤
│ RAIL   │                                                       │
│ 240px  │ POSTINGS                                              │
│        │ (list rows by default; cards when toggled)            │
│        │                                                       │
└────────┴───────────────────────────────────────────────────────┘
```

Page max width: bump from `max-w-6xl` (1152px) to no fixed max on the main content; rail stays a fixed 240px. On 14"–27" displays the postings list extends to the full width, which is the whole point of the redesign.

### Mobile (`< md`)

Rail collapses into a "Filters" sheet triggered from the header. Controls bar wraps. Posting cards stack single-column. Status pill stays in the header but the popover opens full-width.

## Motion

Minimal and functional. Only three intentional motions in the system:

1. **Filter chip select**: 120ms ease-out-quart, animates `background-color` and `border-color` only. No transform, no scale.
2. **Source health popover open/close**: 160ms ease-out-expo. Animates `opacity` and a 4px y-translate. Backdrop blur stays off.
3. **Refresh icon spin**: continuous rotation while polling, standard 1s linear loop. Stops the instant the request resolves (no fade-out).

Hover transitions: 80ms ease-out, on `background-color` and `border-color` only. No `transition: all` anywhere.

All decorative motion respects `@media (prefers-reduced-motion: reduce)` — collapses to opacity-only or none.
