---
name: testing-dashboard-e2e
description: Run the shiba dashboard end-to-end locally and seed Durable Object run state (e.g. unknown/error/completed runs) without a real sandbox execution.
---

# Dashboard E2E Testing for shiba

## Environment

- node/pnpm availability varies by box: Linux CI images keep node under
  `~/.nvm/versions/node/v24.19.0/bin` (add to PATH); macOS dev boxes already
  have them via homebrew. Check `which node pnpm` first.
- If `node_modules` looks broken: `CI=true pnpm install --shamefully-hoist`
  (transitive `sharp` must be hoisted or `pnpm build` fails — env quirk, not a bug).

## Serve the real stack

Repo layout is `apps/frontend`, `apps/backend`, `apps/web` (not root-level
`frontend/`/`backend/` — older docs may say otherwise).

- Frontend alone: `pnpm -C apps/frontend dev` → vite on :5173 serving `/app/`.
  vite.config.ts DOES proxy `/api` and `/agents` (ws) to `http://localhost:8788`,
  so with no backend the proxy returns `502` with an empty body (fetch resolves
  non-ok; `.json()` on the empty body throws → dashboards show
  `Unexpected token`-style errors or status-based messages).
- Full stack: run BOTH vite :5173 AND the worker on :8788:

```bash
pnpm -C apps/frontend dev                                          # vite :5173
pnpm -C apps/backend dev                                           # wrangler :8788
# Docker absent / daemon down? wrangler aborts building the Sandbox image —
# the fix wrangler itself prints: add --enable-containers=false
../../node_modules/.bin/wrangler dev --port 8788 --enable-containers=false
```

- Approval-queue endpoints (`POST /api/runs`, `GET /api/approvals`) work fully
  without containers, secrets, or Cloudflare auth — they only write a pending
  approval row in the local CodingOrchestrator DO. Caveats verified locally:
  - `publishPullRequest: true` in the POST body → 400
    `"publishPullRequest was requested but GITHUB_TOKEN is not configured."`
    unless you provide GITHUB_TOKEN (e.g. `--var GITHUB_TOKEN:$GITHUB_PAT` or a
    `.dev.vars`). Use `false` or expect this exact error — useful for testing
    error-rendering paths.
  - Vectorize binding warns "not supported" locally — Memory features degrade;
    everything else is fine. AI binding is remote-mode but only touched when a
    run actually executes (post-approval).
- `REQUIRE_ACCESS` is unset → all routes are unauthenticated; identity = `"default"`.
- Useful checks: `curl localhost:8788/api/whoami` → `{"agent":"default"}`;
  `curl localhost:8788/api/runs` → `{runs:[...]}` (also triggers `reclaimRuns()`).
- Killing the listener pid alone leaves a zombie — wrangler's supervisor
  respawns workerd, and a half-dead workerd LISTENs but never responds (fetch
  hangs indefinitely; the app's busy state has no timeout). Kill the whole
  tree: `pkill -f "wrangler.js dev"; pkill -f "workerd serve"`.

## Seeding run records without a sandbox

There is no public endpoint to create a run record directly: `POST /api/runs`
only creates a *pending approval*, and `POST /api/approvals` is 404'd at the
worker edge. The reliable seam is the agents-SDK state row in the DO sqlite.

1. With wrangler running, hit `POST /api/runs` once (`{"repoUrl":"https://github.com/o/r","task":"x"}`)
   so the `CodingOrchestrator` DO named `default` is created and its state row written.
2. Stop wrangler (the DO caches `this._state` in memory — inject while stopped).
3. Update the JSON state row:

```bash
node -e '
const {DatabaseSync} = require("node:sqlite");
const f = "apps/backend/.wrangler/state/v3/do/shiba-CodingOrchestrator/<hash>.sqlite"; // the non-metadata .sqlite
const db = new DatabaseSync(f);
const row = db.prepare("SELECT state FROM cf_agents_state WHERE id=\"cf_state_row_id\"").get();
const state = JSON.parse(row.state);
state.runs = [ /* DelegatedRun objects: runId, sandboxId, repoUrl, task, baseBranch,
                  publishPullRequest, generation:1, status, createdAt, updatedAt, receipts:[] */ ];
db.prepare("UPDATE cf_agents_state SET state=? WHERE id=\"cf_state_row_id\"").run(JSON.stringify(state));
'
```

4. Restart `npx wrangler dev --port 8788 --config apps/backend/wrangler.jsonc`
   (add `--enable-containers=false` when no Docker daemon is available).

### Tricks that hit real code paths

- `status:"running"` with `updatedAt > 45min` ago → next `GET /api/runs` runs
  `reclaimRuns()` and flips it to `"unknown"` with `errorCode:"outcome_unknown"`.
  This exercises the real reclaim transition, not a fake fixture.
- `status:"running"` with fresh `updatedAt` stays running.
- Terminal statuses (`completed`, `error`, `cancelled`, `aborted`, `unknown`)
  can be seeded directly; `transitionRun` keeps them immutable.

## UI surfaces under test

- SessionsSidebar (amber/green/red/teal status dots) renders only on the
  **Tasks** view (`/app/`, nav rail "Tasks").
- RunRegistryView (chips, stats cards, all/active/completed/error filter tabs)
  renders on the **Runs** view (nav rail "Runs" or `?tab=runs`).
- Chat websocket (`useAgent`) connects to the `default` DO over wrangler dev and
  shows "Connected"; failure here is environmental, not app breakage.

## Verifying errorWire projections (run-errors.ts codes)

`serializeRun` attaches `errorWire = runErrorWire(errorCode)`:
`{status: "unknown" for outcome_unknown|container_lost else "error", code,
userMessage: RUN_ERROR_DEFS[code].summary}` — userMessage ALWAYS comes from the
DEFS table, never the record's raw `error` text. To prove the table projection,
seed runs whose `error` text is deliberately wrong ("RAW MARKER…") and assert
`curl /api/runs` wires equal the DEFS summaries verbatim.
Known divergence to watch: `terminalStatusFor` (orchestrator.ts ~:51) maps
`container_lost` → record `status:"error"` while the wire says `"unknown"` — a
real container_lost run would render a red chip even though its wire status is
unknown (dashboard chips read record.status).

## Tooling gotchas

- `browser_console` with ANY `content` string only evaluates the script; the
  page console buffer was unreachable in this environment (bare calls also
  evaluated — possible tool regression). Verify console cleanliness via
  `performance.getEntriesByType("resource").filter(r=>r.responseStatus>=400)`
  (expect `[]`), `document.readyState`, and full data render instead.
- Nav-rail/filter clicks land on the wrong view if coordinates are guessed —
  screenshot first, then click measured positions (Runs ≈ (27,115);
  error filter tab is on the RunRegistryView toolbar row, not the nav rail).
