---
name: testing-shiba-dashboard
description: How to run and browser-test the shiba shiba-ai-coworker dashboard locally — dev server, routes, expected backend-down artifacts, and which UI surfaces need live data.
---

# Testing the shiba shiba-ai-coworker dashboard locally

## Run it

```bash
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
cd ~/repos/shiba
pnpm dev        # vite on :5173; opens /app/
```

Dashboard lives at `http://localhost:5173/app/` (root `/` redirects there). `/docs/` serves a stub that meta-refreshes back to `/app/` in dev — real docs come from the worker in prod.

## Expected artifacts when the worker backend is down

Only vite runs in most sessions — the Cloudflare worker (Durable Objects, sandbox API) is NOT up. These are environmental, not bugs:

- `Runs registry: Unexpected token '<', "<!doctype "... is not valid JSON` banner on Tasks (and identical `Identity error` in the sessions sidebar footer): every `/api/*` fetch falls through to the SPA index.html and fails JSON parsing.
- Missions / Automations lists show `Loading…` forever (silent fetch catch, state stays null).
- Agents view settles to an error card with the same JSON message.
- VM view shows `No Virtual Machine Selected` — the terminal/diff/files panels only mount with a selected run, so they cannot be visually verified without a backend.
- Approvals tab shows a `Approval queue: Unexpected token '<'…` error card + `No pending approvals.` — its fetch in app.tsx uses raw `response.json()` and propagates the parse error.
- Inbox / Memory / Audit panels instead degrade to EMPTY STATE ONLY (no error card): their local `apiJson` helper does `response.json().catch(() => ({}))`, so a 200-HTML response becomes empty data. Expect `No mailboxes registered yet…`, `No facts banked yet.` / `No sessions recorded.`, and `No audited tool calls yet.` with no red card — that is graceful-by-design, not a missed error.
- The Agents group in the sessions sidebar only renders when `/api/agents` returns ≥1 principal — with the backend down the whole section is silently absent (silent catch).

## Surfaces testable without the backend

All of these work client-side and were verified in a restyle pass:

- Sidebar nav: 8 views across WORKSPACE (Tasks/Runs/Missions/Automations) + SANDBOX (VM/Agents/Gates/Architecture), navy `#0000a8` active pill, navy header breadcrumb (`AI Coworker / <label>`).
- SYSTEM cluster: Setup Guide modal (6-step onboarding), Documentation link (`href="/docs/"`), Keyboard shortcuts modal (7 rows), theme toggle.
- Theme: `next-themes` toggles `html.dark`; dark mode is `filter: invert(1) hue-rotate(180deg)` on the root with img/video/canvas re-inverted — the whole page flips, not per-component styling.
- ⌘K button in header + Ctrl/Cmd-K: cmdk command menu; all 8 "Go to …" items + New task + toggles.
- Tasks view: sessions sidebar (New task button focuses `[data-testid="task-composer"] textarea`, search filters to "No sessions match your search."), task composer (textarea, repo URL, base branch, harness select, Create PR checkbox, Clear→confirm modal, Send enabled only when task+repo non-empty).
- Workspace panel (right rail on Tasks view): SIX tabs — Runs, Inbox, Memory, VM, Diff, Approvals. Inbox/Memory/Audit controls work client-side: mail/recall searches accept input, submit, swap in a "Clear" button and a results/empty heading; mailbox `<select>` + all Refresh buttons are clickable without crashing. The Approvals tab's `Approvals →` notice link only appears after a real draft-send (needs backend).
- Keyboard: `?` shortcuts modal, `D` theme toggle, `[`/`]` sidebars, Esc closes modals — guarded by `isEditableTarget` so typing never triggers them.

## Gotchas

- The sessions search ✕ clear button is a tiny target (~x=290,y=157 at 1024px); clicks at the input's far right edge land in the field, not on the button.
- `Send` requires BOTH task text and repo URL, and even then shows "Task not sent" when the orchestrator is unreachable (expected).
- Old dark-theme hexes were fully removed in the restyle commit — grep `src/dashboard/` for `#0a0c10|#0d1117|neutral-800|f06666` to confirm no leftovers before visual review.
- Console hygiene: two mount-time entries are expected, not bugs — (a) React dev `Encountered a script tag…` from `next-themes`' anti-flicker ThemeScript, (b) `Failed to parse initial messages JSON` from `@cloudflare/ai-chat-react` hitting `/api/messages` without the worker. Runtime console is otherwise silent: failed API fetches go into UI error state, not console noise.
- New package deps on recent branches (`@modelcontextprotocol/sdk`, `postal-mime`) need `pnpm install` before `pnpm dev` or vite re-optimizes on first load anyway.
