# Homepage (functional dashboard) + docs implementation plan

Status: PROPOSED — nothing here is implemented yet. This file is the plan only.
Authority: `spec/GOAL.md` ("Dashboard", "Required architecture", "Verification"). This plan defers to it. Latest user direction adds Astro+Starlight docs for the project.

## Scope

In: functional dashboard UI (compose/approve/observe flow, states, styling), duplicate-client cleanup, Astro+Starlight static docs under `/docs/`, root build wiring, tests.
Out: marketing page, backend/worker rewrites (one wrangler assets flag excepted, below), deploy or push of any kind, new SDK/API contracts, new dashboard libraries or fonts.

## Part A — Dashboard baseline decision

Consolidate on `client/main.tsx` -> `client/app.tsx` + `client/styles.css`. A later step points `client/index.html` at `/main.tsx` (Vite root is `client/`). Do NOT assume the baseline is correct.

Verified baseline defects (from source):
- `clearAll` fires `chat.clearHistory()` then `fetch("/api/runs", DELETE)`; only the fetch is try/caught, HTTP status is not checked, and the SDK call's promise is not awaited/checked. On partial failure the UI must not claim a complete clear: state exactly what succeeded (SDK history cleared) and what failed (registry still returning runs), never "history kept" if the SDK clear already succeeded.
- `cancelRun` awaits `fetch(..., DELETE)` without checking status or handling rejection. Catch errors, surface them, keep visible run rows.
- Pending approvals derive from `getToolPartState(part) === "waiting-approval"`; render path must be validated against real `chat.messages` shapes or the approval list silently empties.
- Submit clears `task` after `await chat.sendMessage(...)` with no failure branch; input must not be lost on a failed submit.
- Approval decision buttons must disable while a decision is in flight AND re-enable if the `addToolApprovalResponse` call errors, so a failed decision is retryable instead of permanently locked.

Recorded baseline gate check (2026-09-16): `npm run typecheck` — 2 errors; `npm test` — 0 failures; `npm run build` — 1 error, the currently mounted chain fails because the `agents/client-ai-sdk` import resolves to nothing exported. Gates are NOT green today; the consolidation must end with one full green pass (see sequence).

The mounted chain `client/src/index.tsx` -> `client/src/App.tsx` is broken: missing `lucide-react` (absent from package.json); the mount effect calls `fetchRuns`, which is referenced from outside its defining scope and never bound — a ReferenceError at runtime; `pendingApprovals` is a constant `[]`; raw `cf_agent_tool_approval` WebSocket messages replace the SDK. Plan does NOT fix it; it is removed.

## Preserved contracts (do not change)

- SDK: `useAgent`/`useAgentChat`, `addToolApprovalResponse`, `getToolApproval`, `useAgentToolEvents`.
- Worker API: `GET /api/runs` -> `{ runs }`, `DELETE /api/runs` -> `{ ok }`, `GET/DELETE /api/runs/:id` (DELETE = cancel), agent WebSocket routes. No `POST /api/runs` is invented; submission goes through chat. Worker edits only if implementation proves an essential API gap, with justification.
- Approval gate: `delegate_coding_task` has `needsApproval: true`; nothing auto-approves.

## Data facts the UI must respect

- Registry `DelegatedRun`: `runId, sandboxId, repoUrl, task, baseBranch, publishPullRequest, status(pending|running|completed|error|aborted|cancelled), createdAt, updatedAt, summary?, error?`. NO `changedFiles`/`diff`/`pullUrl` fields — those arrive via transcript text (`renderRunTranscript`) and `useAgentToolEvents`, not `GET /api/runs`.
- Cancel: `DELETE /api/runs/:id` transitions the registry record to `cancelled` first, then best-effort destroys the sandbox (destroy failure is logged, not surfaced). UI says "cancellation requested", never "stopped".

## Design direction

Calm dark developer workspace, native CSS, system sans + `ui-monospace`, no libraries, no new fonts; existing `--bg/--panel/--line/--text/--muted/--accent/--danger/--ok` tokens retained and extended only as needed. Adapted at text/token level only: Codepen (compact charcoal editor panels, mono metadata) for log/diff blocks; developer.apple.com (type hierarchy, restrained separation) for section spacing; Superlist (task grouping) for run grouping.

Research provenance and caveats: references were gathered through the locally installed `inspo` MCP (https://inspomcp.dev/api/mcp, configured in `~/.claude.json`; `claude mcp list` reports Connected; session tools were not exposed so JSON-RPC `recommend` / `search_screens` / `get_design_system(live:false)` were used). Captures dated 2026-05-04: https://codepen.io (slug `codepen-io`), https://developer.apple.com (slug `developer-apple-com`), https://superlist.com (slug `superlist-com`). Text/token research only — never visually inspected; captures may be stale relative to the live sites. These are public marketing pages, not validated dashboard UX: reject Inspo feature stacks, ~90px hero, marketing spacing. Adapt ideas, not branding.

## Layout and flow

- Header: title, one-line self-hosted Cloudflare copy, real connection state from `agent.identified`/`connectionError`.
- Desktop >= ~860px: grid — composer left (~340px), conversation + approvals right, full-width runs beneath. Mobile: document stack, 16px gutters; checked at 320/375/768/1440. No sidebar, no metric tiles.
- Flow: repo/task (+ optional PR checkbox) -> send for approval -> approval card shows the EXACT pending tool input -> approve/reject -> live events -> files/diff/optional PR link. All states render from real data.

## States (all from real data; honest wording)

Offline/reconnect (pill reflects agent state, no fake "connected"); submitting (disabled button, input preserved); failed submit (`chat.error` shown, task text kept); planning/running (live tool activity; announce transitions, not every log line); awaiting approval (exact input, keyboard-accessible, disabled after decision, re-enabled on decision error); rejected (visible state, input preserved); success with empty diff ("No file changes produced"); failure (registry error/aborted + bounded stderr tail); truncation labeled; history load failure (keep last good data); clear history (confirm first; explicit partial-success on registry-clear failure; no invented retries); cancel ("cancellation requested" until registry reflects it); no unwanted scroll/focus.

## Accessibility and presentation

Native `<details>` per run disclosure (`aria-expanded` semantics built in; summary as accessible name); logs scroll horizontally in their own container; polite live region for connection + approval transitions only; visible `:focus-visible`; `prefers-reduced-motion` honored; labels on all fields; real `<form>` Enter submission.

## Duplicate chain removal (conditional, after verification)

First diff `client/src/` against the baseline for unique helpers/imports. The one candidate worth evaluating is `agentToolRunsToApprovalRequests` (`agents/client-ai-sdk`) — note the current build already fails on this unexported import, so it likely has no working value; confirm before porting anything. No speculative API-origin override feature (drop `VITE_API_ORIGIN` ideas entirely). Then delete `client/src/` (including `App.module.css`, `lib/`) as one reversible step. Do not extract helpers from the baseline solely to make them testable.

## Part B — Docs (Astro + Starlight, planning only)

Architecture: single root package and lockfile — no docs-local package, no workspaces. Astro runs with `--root docs`; static output only, no adapter, no SSR (Context7 `/withastro/docs`, configuration reference: https://docs.astro.build/en/reference/configuration-reference/ — static output is default; `outDir` documented). Starlight provides navigation, search, theming, accessibility — use natively, no custom reinvention. Manual setup verified via Context7 `/withastro/starlight` (https://starlight.astro.build/manual-setup/): the docs collection is defined in `docs/src/content.config.ts` with `defineCollection`, `docsLoader` from `@astrojs/starlight/loaders`, and `docsSchema` from `@astrojs/starlight/schema`; Starlight prerenders its pages. Pagefind indexing is skipped during development, so search is tested from a production preview of the built output, never from `docs:dev`. Functional React dashboard stays at `/` per GOAL.

Build order (root `npm run build`): 1) `vite build` (empties `public/`), 2) `astro build --root docs` into `docs/dist` with `base: '/docs'`, 3) small copy step (`scripts/copy-docs.mjs`, ~15 lines, fs.cp) moving `docs/dist` -> `public/docs`. This ordering prevents Vite's `emptyOutDir` from wiping docs output. `docs:dev` on port 4321 (`astro dev --root docs --port 4321`); `docs:check` runs `astro check --root docs`.

Wrangler 404 implication: `backend/wrangler.jsonc` currently sets `not_found_handling: "single-page-application"`, so any missing `/docs/*` path would serve the SPA shell instead of 404. Plan: switch to `"404-page"` with a static 404 (hand-authored minimal `client/public/404.html` so Vite copies it into `public/`; Astro's generated `404.html` lands at `public/docs/404.html` via the copy step). `/api` and `/agents` are Worker-routed before assets and unaffected. The dashboard has no client-side routes, so a global static 404 is safe; if this config change is judged too invasive at review, that decision is made explicitly, not silently.

File map (proposed):
```
docs/
  astro.config.mjs          # starlight integration, base '/docs', no adapter
  src/content.config.ts     # defineCollection + docsLoader (@astrojs/starlight/loaders) + docsSchema (@astrojs/starlight/schema)
  src/content/docs/*.md     # pages below
  src/styles/custom.css     # ONLY if a genuine gap; otherwise pure Starlight
scripts/copy-docs.mjs
client/public/404.html
```
New devDependencies: `astro`, `@astrojs/starlight`, plus `@astrojs/check` for `docs:check`. Node floor stated in docs comes from installed engines, not README: Vite 8 requires `^20.19.0 || >=22.12.0` (verified in installed node_modules); README's "Node.js 18 or later" is wrong. Astro's own engines verified from the installed package at implementation. Setup sources: https://docs.astro.build/en/reference/configuration-reference/ and https://starlight.astro.build/manual-setup/.

Pages (`docs/src/content/docs/`): overview; getting-started (prerequisites); configuration (env vars + AI Gateway setup); local-development; dashboard (approvals, runs, states); deployment; github (optional PR/webhook); security (account ownership, Access requirement, single-tenant honesty); architecture (orchestrator/sub-agent/sandbox/provider path, runtime adapter seam); troubleshooting; costs; contributing.

Content rules:
- Written from source (`src/`, `backend/wrangler.jsonc`, `.dev.vars.example`), not the stale README.
- Label "Current behavior (as implemented)" vs "Specification target (GOAL)" where they diverge; no invented behavior.
- Gateway reconciliation: README describes AI Gateway with Unified Billing or stored BYOK plus `AI_GATEWAY_TOKEN`; GOAL says the real provider credential never enters a container, command, process environment, logs, or UI output. Docs describe only what `backend/src/provider-gateway.ts` verifiably does, keep the container-sees-dummy-key claim, and flag any README/GOAL divergence as an open item rather than papering over it or making untrue credential/security claims.
- Static docs never publish private run content, run registries, or secrets; documentation of protection says Cloudflare Access (or equivalent) is required — URL obscurity is not protection.

## Implementation sequence (each step is independently revertable; full green gate is a single checkpoint AFTER consolidation, since intermediate steps cannot all typecheck while the broken chain exists)

1. `client/styles.css` — extend tokens and add log/diff/details/mobile styles.
2. `client/app.tsx` — behavior fixes: clearAll partial-success reporting, cancelRun error handling, submit-failure input preservation, approval duplicate-decision guard with re-enable on error. Extract helpers only where they remove real duplication, never solely for testability.
3. `client/app.tsx` — states, announcements, details-based run disclosure from existing data sources.
4. `client/index.html` — script src -> `/main.tsx`.
5. Delete `client/src/` per the conditional above; then run the FULL gate (`typecheck`, `lint`, `test`, `build`, `wrangler deploy --dry-run`) and resolve to green. Dry-run validates bundling only; full container behavior cannot be verified locally without a container engine — stated honestly.
6. Docs scaffolding: deps, root scripts (`docs:dev`, `docs:build`, `docs:check`, composite `build`), `docs/astro.config.mjs`, `content.config.ts`, copy script, `client/public/404.html`, wrangler `not_found_handling: "404-page"`.
7. Docs content: the twelve pages, following the content rules.
8. Tests: `backend/test/ui-helpers.test.ts` in the existing Vitest node environment only if step 2 produced genuinely pure helpers (deterministic, development-only fixtures in-file). A browser-environment component test would need a new dependency — add only if a behavior cannot be tested otherwise, with justification.

## Tests and verification

Existing tooling: Vitest node environment, no jsdom/happy-dom/testing-library. Baseline gate status recorded above is NOT green; nothing in this plan claims tests pass — results are pending until run.

Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npx wrangler deploy --dry-run`, plus `npm run docs:check` and `npm run docs:build`.

Manual browser checks (local `npm run dev`): composer validation, approval round-trip rendering against fixtures/mocks — no real sandbox approvals locally. Fixtures are deterministic and labeled development-only.

## Acceptance criteria

| # | Criterion | Check |
| --- | --- | --- |
| A1 | index.html loads /main.tsx; no client/src remains | build + tree check |
| A2 | Approve/reject calls addToolApprovalResponse once; duplicate clicks inert; re-enabled on decision error | code + manual |
| A3 | Failed submit/clear/cancel keep user-visible data and show explicit partial-success or error | code + manual |
| A4 | Files/diff/PR render only from transcript/events; registry fields used as-is | code review |
| A5 | All states rendered; no fake metrics/activity | walkthrough 320/375/768/1440 |
| A6 | Keyboard-only approval; logs scroll horizontally; reduced motion honored | manual |
| D1 | `docs:build` emits static output under `docs/dist` with `/docs` base; no adapter | build output |
| D2 | Deep links to every docs page resolve in built output; missing `/docs/*` paths return the static 404, not the SPA shell; `/api` + `/agents` behavior unchanged | 404 test + wrangler dry-run |
| D3 | Starlight search, nav, and theme work in the built output; search verified from a production preview (Pagefind skips dev), not `docs:dev`; mobile nav usable via keyboard | built-output check |
| D4 | All internal doc links resolve; `docs:check` clean | docs:check |
| D5 | `npm run build` run twice consecutively yields a correct `public/` both times (Vite empty-out + docs copy ordering stable) | repeat build |
| A7 | All gates run; failures resolved or listed honestly | command output |
