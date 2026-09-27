# Design — AI Coworker (bezalel.sh system)

Locked design system, derived from bezalel.sh. Every surface — dashboard
(`apps/frontend`) and docs/marketing (`apps/web`) — reads this file first.
Amend this file when the system needs to grow; do not fork per-page styles.

## Genre

retro paper-OS ("designed-as-app"): cream paper, navy accents, square
corners, hard offset shadows, window-chrome panels, mono microcopy,
serif display type, pixel-crisp details. Dark is the default across the
dashboard, docs, and marketing site; light remains an accessible opt-in.

## Tokens (canonical — dark default; light override)

```css
--paper:        #f6f4ed;  /* app background */
--card:         #fffef8;  /* raised surface */
--panel-2:      #f1efe6;  /* sunken/secondary surface */
--ink:          #222320;  /* text */
--ink-2:        #6a6f63;  /* quiet/muted text */
--line:         #e0ded5;  /* hairline */
--line-2:       #d3d2c8;  /* stronger hairline / card border */
--input-line:   #a5a69b;  /* input border */
--navy:         #0000a8;  /* primary accent — the ONLY brand accent */
--navy-2:       #1c1cc8;  /* hover */
--paper-title:  #0000a8;  /* window titlebar bg */
--paper-title-fg: #ffffff;
--paper-shadow: #2527261c;/* hard offset shadow color */
--paper-dot:    #24272919;/* dot-grid canvas dot */
--ok:           #227146;
--pending:      #976400;  /* text-safe amber */
--pending-bg:   #f99c00;
--danger:       #b52b2b;
--danger-fg:    #fb2c36;  /* loud red only for dots/icons */
```

Light override (use the same semantic tokens; never invent a separate theme):

```css
--paper:#191a18; --card:#222320; --panel-2:#272824; --ink:#eae8e1;
--ink-2:#aaa99f; --line:#3b3d36; --line-2:#3b3d36; --input-line:#707368;
--navy:#9cbce2; --navy-2:#dceafa; --paper-title:#222320;
--paper-title-fg:#eae8e1; --paper-shadow:#00000035; --paper-dot:#eae8e119;
--ok:#95c4a0; --pending:#d9be80; --danger:#ee9690;
```

## Typography

- Display: **Instrument Serif** 400, roman and italic; hero sizes clamp
  (dashboard headings 15–24px; marketing hero up to clamp(57px,6.5vw,94px),
  line-height ~1.03). Tracking -0.01em.
- Body: **Geist** 400–600, 13–15px, line-height 1.5–1.65.
- Mono: **Geist Mono** — every micro-label, meta line, tab label, chip,
  count badge, statusbar. Microcopy is 9–11px, uppercase tracking
  0.10–0.14em where it labels a group.

## Shape language (hard rules)

1. `border-radius: 0` everywhere — no rounded cards, pills, or bubbles.
   The only circles allowed are ≤10px status dots (size-1.5/size-2) and
   the mascot avatar when masked as a real avatar.
2. Shadows are hard offsets only: `2px 2px 0 var(--paper-shadow)` on
   buttons/chips/cards and `3px 3px 0 var(--paper-shadow)` on
   windows/dialogs. **No blur/glow/diffuse shadows, ever.**
3. Buttons: `rounded-none`, h-8/9, `active:translate-y-px`. Primary =
   `bg-[#0000a8] text-white border border-[#0000a8]
   shadow-[2px_2px_0_var(--paper-shadow)] hover:bg-[#1c1cc8]`.
   Secondary/ghost = border `--line`, paper bg, `hover:bg-[#e9e8df]`.
4. Chips/badges: square, `text-[9–10px] font-mono uppercase`, 1px border,
   tinted bg. Status colors: ok green, running navy, pending amber,
   error red — same semantic map as `STATUS_CHIP_CLASSES`.
5. Panels that feel like windows get a **titlebar**: mono 11px, min-h
   ~31px, `bg-[#0000a8] text-white px-2`, left = icon + dotted/label,
   right = optional "window marks" (three 14×13 beveled squares:
   `bg-[#bdbdbd] border border-[#444] border-t-[#f5f5f5]
   border-l-[#f5f5f5]` — first mark carries a 6px underscore rule,
   second a small inner frame).
6. Section content canvases may use the **dot grid**:
   `background-image: radial-gradient(var(--paper-dot) .7px,
   transparent .7px); background-size: 12px 12px`.
7. **Statusbar** footers: mono ~9px row of square cells separated by 1px
   border; cells carry terse facts ("3 agents", "1 token", counts).
8. Numbered cards: cards in a grid may show a mono `01` `02` … index
   top-right (icon top-left), like bezalel capability cards.
9. Logo/mascot imagery: `image-rendering: pixelated` where it sits in
   chrome/brand slots.
10. Selection: `selection:bg-[#0000a8] selection:text-white`.

## Layout grammar

- Dashboard uses a full-width primary workspace. Runs, Inbox, Memory, VM,
  Diff, and Approvals must remain reachable as primary navigation or
  standalone views; do not restore a persistent right-hand sidebar.
- Keep the task/session navigation and task composer available where they
  are part of the current workflow, but let the active surface use the full
  remaining canvas width.
- Section headings: left = serif `h2/h3`; right/above = mono 10px
  quiet annotation ("7 capabilities · one token" style).
- Compatibility-strip idiom: a flex row ruled top/bottom — mono uppercase
  label, mono items, quiet trailing clause.

## Voice

Terse mono microcopy; sentence-case UI prose; approval-gate copy stays
unchanged and unhidden (approval gate is sacred).

## What every surface MUST share

- Navy `#0000a8` as the sole accent; ≤5% of any viewport.
- Dark paper `#191a18` page field, `#222320` cards, hairline `#3b3d36` rules
  by default; light uses the corresponding cream paper tokens above.
- Instrument Serif display + Geist body + Geist Mono microcopy.
- Zero radius, hard offset shadows, square chips, dot-grid canvas.

### Token names — one vocabulary (revised 2026-09-27)

The names above are **canonical**. `apps/web` already uses them verbatim.
`apps/frontend` declares them as the source of truth and exposes a small set of
local aliases for its existing utility classes:

| Canonical (`design.md`) | Frontend alias | Light value |
|---|---|---|
| `--paper` | `--bg` | `#f6f4ed` |
| `--card` | `--panel` | `#fffef8` |
| `--ink` | `--text` | `#222320` |
| `--ink-2` | `--muted` | `#6a6f63` |
| `--navy` | `--accent`, `--brand`, `--running` | `#0000a8` |
| `--navy-2` | `--accent-light`, `--brand-light` | `#1c1cc8` |

Rules:

- **Declare canonical tokens with literal colors; declare aliases as
  `var(--canonical)`.** Then a dark-theme override of `--paper` re-points
  `--bg` automatically, and there is exactly one place to edit a color.
- **New code uses the canonical names.** Aliases exist for existing utility
  classes, not as an alternative vocabulary.
- **Never introduce a third name for a color that already has one.** If a value
  is not in this table, it is not a token — it belongs in `styles.css` only if
  it is genuinely new, and it must be added here in the same change.

**Known fragility (do not extend):** the dashboard's Tailwind call sites use
hardcoded arbitrary values (`bg-[#f6f4ed]`), so dark mode works by remapping
those exact class tokens under `html.dark` rather than by swapping variables.
That remap is a stopgap for an unfinished migration, not a pattern. A new
surface should use canonical variables — which works in both themes with no
remap entry.

## What surfaces MAY differ on

- Which panels carry full window chrome (titlebar/marks/statusbar).
- Dot-grid placement (hero canvases, dashboard stat wells, empty states).
- Density: dashboard tighter than docs.
