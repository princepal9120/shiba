### Task 14 — main/tasks view + dashboard visual-consistency pass
**Files:** `src/dashboard/components/*.tsx` (every view: TaskComposer,
SessionsSidebar, WorkspacePanel, RunRegistryView, MissionsView, GatesView,
ArchitectureView, VMInspector, AutomationsView, AgentsView, InboxTab,
MemoryTab, ApprovalCard, OnboardingModal, AppNavRail, ui/*), `src/dashboard/
styles.css`, `src/dashboard/app.tsx`, `app/index.html` (meta only if stale)

Goal: the entire SPA reads as ONE product under the Bezalel system already
established on this branch (navy header, cream sidebar, Geist +
Instrument Serif + Geist Mono, token colors in styles.css, light default +
dark mode). PR #7 restyled the shell; this task sweeps the interiors.

- Audit every view for pre-Bezalel leftovers: hard-coded hex colors not in
  the token set, non-Geist/Instrument/Mono fonts, legacy card/button/badge
  styles, inconsistent spacing or typography, off-system borders/radii.
- The default tasks view (the "main page" a user lands on) is the priority
  surface: hero/empty state uses Instrument Serif display type like the
  reference bezalel.sh, composer card matches the cream card system.
- New tabs (Inbox, Memory, Audit section, Agents) must use the same
  primitives: `statusChipClass`, ghost buttons, `--pending` amber, `--ok`,
  mono time/meta text. No new accent colors.
- Dark mode parity: every touched surface checked in both themes via the
  token layer — no light-only hex.
- Keep diffs inside the dashboard files; do not touch worker/backend code.

Checks: `pnpm build:dashboard`, `pnpm typecheck`, `pnpm lint` green; add or
extend a component smoke test only if the repo already has that pattern.
