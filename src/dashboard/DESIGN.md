# Dashboard design contract — "minimal Linear/Hoplite" pass

Reference: Linear app UI (inspo `linear-app` design system) + the Hoplite
screenshot the user provided. One dark, quiet workbench. No decoration.

## Hard rules (apply to every file in src/dashboard/)

- **Flat surfaces.** No gradients, no `backdrop-blur`, no `glass-panel`
  glow, no `shadow-[0_0_*]` glows, no `animate-pulse`/`animate-pulse-subtle`
  on decorative elements, no dashed borders. Borders are solid hairlines.
- **No emoji, no mascot art** anywhere in chrome or empty states
  (`/assets/mascot/*` is gone from the UI). Use the inline SVG icon set only.
- **No `font-display`, no Space Grotesk/Bebas/Bangers.** Inter everywhere;
  `font-mono` (DM Mono) only for code, ids, kbd hints, timestamps.
- **Radius:** `rounded-md` (6px) for controls, `rounded-lg` (8px) max for
  cards/panels. No `rounded-xl`/`rounded-2xl`/`rounded-full` chips except
  status dots and kbd pills.
- **Weight:** `font-medium` default for emphasis; `font-semibold` only for
  primary headings. No `font-bold`/`font-extrabold`.
- **Accent discipline.** Teal (`#2dd4bf` text / `#0B9F95` fills) only for:
  live/running status dot, active nav indicator, focused-state border, and
  "live" session title. Everything else is neutral zinc. Semantic colors stay
  only for status: ok `#4cc38a`, warn `#d9a13b`, danger `#f06666`,
  info `#4f9cf0` — used as small dots/text, never as fills with glow.
- **Primary action button** = light ink: `bg-zinc-100 text-zinc-900
  hover:bg-white` (the "New task" / "Send" pattern from the reference).
  Secondary = `border border-white/10 text-zinc-300 hover:bg-white/5`.
  Danger = `text-[#f06666]` or subtle `bg-[#f06666]/10 border-[#f06666]/30`.

## Tokens (already in styles.css — use them)

- bg `#0a0a0b`, panel `#101013`, elevated `#161619`
- line `rgba(255,255,255,0.07)` (~`border-white/[0.07]`), strong `#232529`
- text `#e4e4e7`, secondary `#a1a1aa`, muted `#71717a`
- Tailwind shorthand: prefer `zinc-*` scale over arbitrary hex where it
  matches (zinc-200 #e4e4e7, zinc-400 #a1a1aa, zinc-500 #71717a,
  zinc-900 #18181b, zinc-950 #09090b).

## Typography

- UI text 12–13px; section labels `text-[11px] font-medium uppercase
  tracking-wide text-zinc-500` (used sparingly); view titles
  `text-sm font-semibold`; never giant headings inside the app.
- Letter-spacing: default; `-0.01em` on titles only. No `tracking-[0.1em+]`
  mono labels except tiny kbd hints.

## Layout

- One left sidebar (248px): brand row, search, white "+ New task", nav items
  (icon-left + label + optional count badge), "Sessions" list, utility footer.
- Main top bar: `h-11`, hairline bottom border, view title + minimal actions.
- Composer: rounded-md bordered box docked bottom, not a full-width strip.
- Panels/cards: `bg-[#101013] border border-white/[0.07] rounded-lg`.
- Empty states: one line of muted text, optional small muted icon. No art.

## Do NOT change

- Component props, exported names, DOM test hooks
  (`data-testid`, aria-labels, role attrs), fetch/agent logic.
- Strings asserted in test/dashboard.test.ts: "Sessions", "Setup Guide",
  nav labels Tasks/VM/Runs/Agents/Automations/Missions/Gates/Architecture,
  "No messages yet. Submit a task to start.", "Fix Failing Tests",
  "No runs. Approved tasks appear here while they execute.",
  view headings ("VM Inspector", "Run Registry & Workspaces",
  "Automations & Inbound Triggers", "System Architecture & Isolation Boundary",
  "Setup & Onboarding Guide", "Code Review", "QA", "Security Review",
  "Publish result as a PR", "Standing goal", "Deploy mission",
  "approval-gated", "Total Runs", "Inspect Virtual Machine",
  "Changes & Diff", "Workspace Files", "Terminal & Exec", "Web Preview",
  "Share VM View", "Isolated Sandbox VM", onboarding step titles, "All (6)",
  "Pending (5)", "Completed (1)"), aria-label="Collapse sidebar",
  aria-label="Open sessions", aria-expanded, approval copy
  ("waiting for your approval", "Action Required", "Approve", "Reject").

