# Design — AI Intern

Locked design system. Every page redesign reads this file first. Do not
regenerate per page — amend this file when the system needs to grow.

## Genre

modern-minimal (dev-tool / infra)

## Macrostructure family

- Marketing pages: n/a (no marketing surface in this repo)
- App pages:       Workbench — dashboard (`dashboard/src/`). Dense panels,
  tab-nav, data rows; variation in card archetypes only.
- Content pages:   Long Document — docs (`web/`, Starlight). Sidebar + prose
  column; variation in aside/card archetypes only.

## Theme

Custom, anchored on brand teal `#0B9F95` ≈ `oklch(60% 0.11 185)`.

Dark (dashboard, docs dark):
- `--color-paper`   oklch(14% 0.010 260)   /* #0a0c10-ish charcoal */
- `--color-paper-2` oklch(18% 0.012 260)
- `--color-ink`     oklch(92% 0.010 240)
- `--color-ink-2`   oklch(65% 0.015 240)
- `--color-rule`    oklch(28% 0.015 260)
- `--color-accent`  oklch(60% 0.110 185)   /* brand teal */
- `--color-accent-2` oklch(78% 0.120 180)  /* #2dd4bf */
- `--color-focus`   oklch(78% 0.120 180)

Light (docs only):
- `--color-paper`   oklch(98% 0.005 240)
- `--color-paper-2` oklch(95% 0.008 240)
- `--color-ink`     oklch(22% 0.020 260)
- `--color-ink-2`   oklch(45% 0.020 260)
- `--color-rule`    oklch(88% 0.010 240)
- `--color-accent`  oklch(55% 0.110 185)
- `--color-focus`   oklch(55% 0.110 185)

Existing hex values in `styles.css` / `theme.css` are the deployed
equivalents of these tokens — keep files referencing named tokens.

## Typography

- Display: Space Grotesk, weight 500–700, roman only
- Body:    Inter, weight 400–600
- Mono:    DM Mono, weight 400–500
- Display tracking: -0.02em
- Body size: 14–16px, line-height 1.5–1.65

## Spacing

8pt base scale (`--space: 8px`, `--gutter: 16px` in dashboard;
Starlight defaults in docs). Named tokens only.

## Motion

- Easings: `--ease-out cubic-bezier(0.16, 1, 0.3, 1)`
- Reveal: none — app and docs render fully formed
- Reduced-motion: opacity-only, ≤150ms (already enforced)

## Microinteractions stance

- Silent success; no celebratory toasts
- Hover transitions ≤200ms, `transition-colors` on interactive rows/cards
- Focus ring: 2px accent-2, 2px offset, instant (never animated)

## CTA voice

- Primary: teal fill, black ink, 8–12px radius, semibold label
- Secondary: transparent, 1px `--color-rule` border, ink label

## What pages MUST share

- Accent teal and its ≤5% placement per viewport
- Inter body + DM Mono code; Space Grotesk for display headings
- Focus ring spec and CTA shape
- Charcoal dark paper; docs additionally ship the light paper

## What pages MAY differ on

- Card/panel archetypes within the Workbench family
- Aside/callout archetypes within the Long Document family
- Density (dashboard is tighter than docs)

## Exports

### tokens.css

```css
:root {
  --color-paper:      oklch(14% 0.010 260);
  --color-paper-2:    oklch(18% 0.012 260);
  --color-ink:        oklch(92% 0.010 240);
  --color-ink-2:      oklch(65% 0.015 240);
  --color-rule:       oklch(28% 0.015 260);
  --color-accent:     oklch(60% 0.110 185);
  --color-accent-2:   oklch(78% 0.120 180);
  --color-focus:      oklch(78% 0.120 180);

  --font-display: "Space Grotesk", sans-serif;
  --font-body:    "Inter", sans-serif;
  --font-mono:    "DM Mono", monospace;

  --space-xs: 0.5rem; --space-sm: 1rem; --space-md: 1.5rem;
  --space-lg: 2rem;   --space-xl: 3rem;

  --ease-out:  cubic-bezier(0.16, 1, 0.3, 1);
  --dur-short: 200ms;
  --radius-card: 12px; --radius-input: 8px;
}
```

## Workbench layout

Devin-style three-pane agent workbench for the dashboard Tasks view
(`dashboard/src/`). Other views keep working under the same slim top
header (`h-14`): logo + Shiba, nav tabs, sandbox pill, connection,
setup, docs.

```
┌──────────────────────────────────────────────────────────────┐
│ TOP HEADER (slim, h-14)                                      │
├──────────┬────────────────────────────────┬──────────────────┤
│ SESSIONS │  CONVERSATION TIMELINE         │  WORKSPACE PANEL │
│ ~300px   │  · session header              │  ~400px, tabs    │
│ search   │  · step feed (icon rail)       │  Runs|VM|Diff|   │
│ +New task│  · inline approval cards       │  Approvals       │
│ run rows │  · sticky TASK COMPOSER        │  collapsible→40px│
└──────────┴────────────────────────────────┴──────────────────┘
```

### Panes

- **Sessions sidebar (~300px):** "Sessions" header, search input,
  "+ New task" primary CTA, session rows (`.session-row`). Row =
  title (truncated), mono meta line (repo · status · time-ago).
  Selected row: `--panel-elevated` bg + `--line-light` border.
  Live session row tints title `--accent-light`.
- **Conversation timeline:** Devin-style step feed on a left icon
  rail (`.step-rail`): 1px `--line` vertical connector, 24px icon
  circles on `--panel`. Steps: "Ran \<tool\>" mono label + status
  chip + expandable `<details>` output (mono, max-h-56 scroll).
  User messages stay right-aligned blue bubbles. Waiting-approval
  steps also render an inline approval card (amber `--pending`
  border, Approve `--ok` fill / Reject `--danger` outline) — the
  approval gate is sacred: never auto-approve, never hide.
- **Workspace panel (~400px):** tab bar Runs | VM | Diff |
  Approvals (`.workspace-tab`, count badges via
  `.workspace-tab-badge`). Collapses to a 40px icon rail.
- **Task composer (`.composer`):** pinned at timeline bottom.
  Rounded-xl `--panel` card, `--line` border (`--accent` on
  focus-within). Auto-growing textarea + collapsed config row
  (repo, branch, harness select, PR checkbox, Clear ghost, Send
  primary teal). ⌘Enter submits.

### Workbench rules

- Accent teal stays ≤5% of viewport — rail icons, selected states,
  primary CTAs only.
- All surfaces from tokens: `--bg`, `--panel`, `--panel-elevated`,
  `--line`, `--line-light`; ink `--text`/`--muted`; semantics
  `--ok`, `--pending` (#c9a227 for approvals), `--danger`,
  running blue #4f9cf0.
- Status chips reuse the existing `statusColors` map in app.tsx.
- Density: 8pt spacing, radius 8–12px, `transition-colors` ≤200ms,
  silent success (no toasts).
