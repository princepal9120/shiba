---
name: testing-dashboard-e2e
description: Run the shiba-ai-coworker dashboard end-to-end locally and seed Durable Object run state (e.g. unknown/error/completed runs) without a real sandbox execution.
---

# Dashboard E2E Testing for shiba-ai-coworker

## Environment

- node/pnpm are NOT on PATH. Prefix every command:
  `export PATH=/home/ubuntu/.nvm/versions/node/v24.19.0/bin:$PATH`
- If `node_modules` looks broken: `CI=true pnpm install --shamefully-hoist`
  (transitive `sharp` must be hoisted or `pnpm build` fails — env quirk, not a bug).

## Serve the real stack

`pnpm dev` (vite, :5173) serves ONLY the dashboard shell — there is **no `/api`
proxy**, so `/api/runs` and `/api/whoami` 404 and the app shows error banners.
For e2e with real data, use wrangler dev, which serves the built dashboard AND
the worker API + local Durable Objects on :8787:

```bash
pnpm build:dashboard        # emits public/ (bundle must contain new CSS classes)
npx wrangler dev --port 8787 --config backend/wrangler.jsonc
```

- `REQUIRE_ACCESS` is unset → all routes are unauthenticated; identity = `"default"`.
- Dashboard URL: `http://localhost:8787/app/`
- Useful checks: `curl localhost:8787/api/whoami` → `{"agent":"default"}`;
  `curl localhost:8787/api/runs` → `{runs:[...]}` (also triggers `reclaimRuns()`).

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
const f = "backend/.wrangler/state/v3/do/shiba-ai-coworker-CodingOrchestrator/<hash>.sqlite"; // the non-metadata .sqlite
const db = new DatabaseSync(f);
const row = db.prepare("SELECT state FROM cf_agents_state WHERE id=\"cf_state_row_id\"").get();
const state = JSON.parse(row.state);
state.runs = [ /* DelegatedRun objects: runId, sandboxId, repoUrl, task, baseBranch,
                  publishPullRequest, generation:1, status, createdAt, updatedAt, receipts:[] */ ];
db.prepare("UPDATE cf_agents_state SET state=? WHERE id=\"cf_state_row_id\"").run(JSON.stringify(state));
'
```

4. Restart `npx wrangler dev --port 8787 --config backend/wrangler.jsonc`.

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
