# Shiba — AI Coworker

[![Site](https://img.shields.io/badge/Site-shiba--ai--coworker.pages.dev-0B9F95?style=flat-square&logo=cloudflarepages&logoColor=white)](https://shiba-ai-coworker.pages.dev/)
[![Documentation](https://img.shields.io/badge/Docs-shiba--ai--coworker.pages.dev%2Fdocs-teal?style=flat-square)](https://shiba-ai-coworker.pages.dev/docs/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

Shiba is an account-owned Cloudflare coding workspace: describe a GitHub task, review the proposed delegation, approve or reject it, and inspect a sandbox-generated diff. The repository is a pnpm monorepo containing a React dashboard, an Astro/Starlight documentation site, and a Cloudflare Worker backend built around Agents and Sandbox containers running OpenCode.

**Status: local prototype, not production-ready.** No live end-to-end cloud run is claimed. The deployed Cloudflare Pages site contains the static landing page at `/`, dashboard UI at `/app/`, and documentation at `/docs/` — it does not include the Worker backend, so it does not establish a live coding run. `VERIFICATION.md` records passing local typecheck, lint, tests, and build checks; the backend remains a prototype until a dated run meets the P2 acceptance bar in `PLAN.md` §15: submit → approve → clone/code/collect with a diff that matches reality, rejection starting no container, honest failure exit codes, PRs with deletions shown as deleted, and peak memory measured.

**Static site (landing, docs, dashboard UI):** [https://shiba-ai-coworker.pages.dev/](https://shiba-ai-coworker.pages.dev/)

- **Landing Page:** [https://shiba-ai-coworker.pages.dev/](https://shiba-ai-coworker.pages.dev/)
- **Documentation:** [https://shiba-ai-coworker.pages.dev/docs/](https://shiba-ai-coworker.pages.dev/docs/)
- **Tasks Dashboard:** [https://shiba-ai-coworker.pages.dev/app/](https://shiba-ai-coworker.pages.dev/app/)

Provider traffic is intercepted at the Sandbox egress boundary and forwarded through the account owner's AI Gateway binding — there is no provider callback route (the dead callback path was deleted; the forwarder and its route no longer exist).

## Repository layout

~~~text
.
├── package.json            # private root: scripts + toolchain devDeps
├── pnpm-workspace.yaml     # workspaces: apps/*
├── turbo.json              # turbo tasks: build/test/lint/typecheck/dev
├── alchemy.run.ts          # the ONE stack — declares the Worker + assets + DOs
└── apps/
    ├── backend/
    │   ├── package.json    # @shiba-ai-coworker/backend
    │   ├── wrangler.jsonc  # worker config + DO migrations + bindings
    │   ├── Dockerfile      # pinned harness image (cloudflare/sandbox base)
    │   ├── .dev.vars.example
    │   ├── src/            # Worker + Durable Objects + harness adapters
    │   └── test/           # vitest suite
    ├── frontend/
    │   ├── package.json    # @shiba-ai-coworker/frontend
    │   ├── src/            # dashboard SPA
    │   └── vite.config.ts  # root=apps/frontend/, outDir=../../public
    └── web/
        ├── package.json    # @shiba-ai-coworker/web (Astro + Starlight)
        ├── public/         # static assets copied into public/
        └── src/            # docs content + landing page
~~~

## How the UI is built and served

`pnpm build` produces one aggregate `public/` directory:

1. Vite builds the dashboard — TanStack Start (SPA mode) generates the shell as `public/app/index.html` and chunks land in `public/assets/`; `apps/web/public/` is copied in (favicons, `_redirects`, mascot assets).
2. Astro builds the landing page (`public/index.html`), the docs (`public/docs/`), `404.html`, and the Pagefind search index; `scripts/copy-docs.mjs` merges `apps/web/dist` into `public/`.

At runtime a single Worker serves that directory via `assets.directory` (`apps/backend/wrangler.jsonc`: `../../public`; `alchemy.run.ts`: `./public`) with `not_found_handling: "404-page"`. The dashboard reaches the backend through same-origin `/api/*` calls — no cross-stack wiring.

## Local quickstart

Requirements: Node.js **22.12.0+**, pnpm **10.0.0+**. A Docker CLI is also required for Wrangler container image packaging; a missing Docker daemon fails even the local dry run.

~~~sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
pnpm docs:preview
~~~

- Dashboard: `pnpm dev` (port 5173; opens `/app/`; `/api` and `/agents` proxy to the Worker on 8788).
- Docs editing: `pnpm docs:dev` (port 4321/docs/; search requires a production build).
- Built Worker/assets: `pnpm build`, then `npx wrangler dev --config apps/backend/wrangler.jsonc`. Containers require a compatible local engine; startup may fail without it.
- Local Worker deployment packaging: `npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc`. This is not a deployment or proof of a live coding run.

## Deploy the UI

The `shiba-ai-coworker` Cloudflare Pages project hosts the static UI. Build the dashboard and docs, then deploy the assembled `public/` directory:

~~~sh
pnpm build
pnpm exec wrangler pages deploy public --project-name shiba-ai-coworker --branch main --commit-dirty=true
~~~

This flow deploys only the landing page, `/app/` dashboard, and `/docs/` documentation. The UI is currently static and has no Worker API or WebSocket proxy.

## Deploy the Worker backend

One command provisions everything with [Alchemy](https://alchemy.run) (`alchemy.run.ts`): Worker, Durable Objects, Containers, KV, R2, D1, Vectorize, and **Cloudflare Access** in front of the dashboard. Prerequisites: Workers Paid plan, Docker running, `npx wrangler login`.

~~~sh
pnpm install
pnpm run bootstrap   # asks for Access emails + secrets → .env, mints the Alchemy token once, builds, deploys
~~~

Re-deploy after changes with `pnpm run deploy` (build + `alchemy deploy`). Preview with `pnpm deploy:preview` (`alchemy plan`); tear down with `pnpm deploy:destroy`. Use `pnpm run …` — bare `pnpm deploy`/`pnpm setup` are pnpm built-ins.

What a live deploy does, secure by default:

- `REQUIRE_ACCESS=1` is always set on live stages: no verified Access identity means 401 on the dashboard and API.
- With `ACCESS_EMAILS` and `WORKERS_SUBDOMAIN` set, it creates an Access app for the Worker host that allows only those emails, and the Worker verifies the `Cf-Access-Jwt-Assertion` JWT (`ACCESS_AUD`) instead of trusting the identity header.
- A second Access app **bypasses** the machine callers, which the Worker authenticates itself: `/api/slack/events`, `/api/slack/command`, `/api/slack/interact`, `/api/github/webhook` (HMAC), `/mcp` (bearer token), `/api/automations/*/trigger` (shared secret).
- Secrets come only from `.env` (see `.env.example`). Alchemy replaces the Worker's secrets on every deploy, so a secret missing from `.env` is removed — don't mix in `wrangler secret put`.

Still manual: add a provider key (BYOK) to the `default` AI Gateway, create the Slack app from `slack-app-manifest.yaml`, and mint an MCP token for Claude Code (see [Use from Claude Code](#use-from-claude-code)). Inbound email needs a domain on Cloudflare with Email Routing sending to the Worker; workers.dev cannot receive mail.

Stage selection goes through `$ALCHEMY_STAGE` only (e.g. `ALCHEMY_STAGE=test-x pnpm run deploy` suffixes every resource name); do not pass `--stage`. State is on the local filesystem by default; `ALCHEMY_STATE_BACKEND=cloudflare` opts into the remote State Store after `npx alchemy provider cloudflare bootstrap`.

Rollback to wrangler (same bindings): `npx wrangler deploy --config apps/backend/wrangler.jsonc` — but it does not create the Access apps, so set them up by hand.

### Use from each surface

| Surface | How |
|---|---|
| Web dashboard | `https://<worker-host>/app/` — Access login with an allowed email |
| iPhone | Same URL in Safari → Share → **Add to Home Screen** (standalone app). Slack mobile works for approvals too. |
| Slack | `@shiba-ai-coworker` in a thread or `/shiba-ai-coworker <repo> <task>`; approve on the card |
| Claude Code | MCP over `https://<worker-host>/mcp` with a bearer token — see below |

### Use from Claude Code

Mint a token into the deployed KV (id printed as `agentTokensNamespace` by `pnpm run deploy`), then paste the printed line:

~~~sh
node scripts/mint-token.mjs --agent claude-code --scopes sandbox:exec \
  --host <worker-host> --namespace-id <agentTokensNamespace> --write
claude mcp add --transport http shiba https://<worker-host>/mcp --header "Authorization: Bearer shb_…"
~~~

Tools: `queue_run`, `run_status`, `list_runs`, `list_approvals` (`sandbox:exec`), plus email and memory tools behind their own scopes. `queue_run` only queues — a human approves in the dashboard, on iPhone, or in Slack; there is no approve tool. Details: [/docs/mcp](apps/web/src/content/docs/docs/mcp.md).

## Documentation

The documentation site at `/docs/` includes setup, configuration, local development, dashboard usage, deployment, GitHub integration, security, architecture, API reference, troubleshooting, cost surfaces, contributing, and an end-to-end acceptance checklist.

Source entry: [docs index](apps/web/src/content/docs/index.md). Content lives in `apps/web/src/content/docs/docs/`. The root build runs Vite (`frontend/`) first, builds Astro into `apps/web/dist`, then copies `apps/web/dist` into `public/` and verifies local links, anchors, assets, and Pagefind output.

## Architecture

~~~text
Browser dashboard / + Starlight docs /docs/
  -> CodingOrchestrator (Think Durable Object; human-approved tool)
  -> OpenCodeAgent (AIChatAgent; structured task envelope)
  -> Sandbox Durable Object + container + OpenCode

Planning model: Workers AI binding
Coding model path: container -> Sandbox egress interception -> AI Gateway binding
No public provider callback: the container never holds a real provider key
Optional PR publishing: GitHub REST API from Worker, never container token
~~~

One installation is single-tenant and account-owned. No Python backend, Docker Compose, Postgres, Redis, or separate Next.js service is required by this implementation. Runs are routed to per-user orchestrator Durable Objects via the `CF-Access-Authenticated-User-Email` header. Default concurrency is five retained active coding runs and five configured container instances (`MAX_CONCURRENT_RUNS = 5`, `max_instances: 5`, `instance_type: standard-1`).

## Platform ceiling

Cloudflare Containers max out at **`standard-4` (4 vCPU / 12 GiB / 20 GB)** — see [Containers limits](https://developers.cloudflare.com/containers/platform/limits/). Heavy builds and large monorepo test suites are out of reach on this platform, by design. Do not expect Capy-class machine sizes (16 vCPU / 128 GB) here.

## Configuration and models

Non-secret defaults in `apps/backend/wrangler.jsonc`:

| Setting | Default |
| --- | --- |
| GATEWAY_ID | default |
| ORCHESTRATOR_MODEL | @cf/meta/llama-3.1-8b-instruct |
| CODING_MODEL | google/gemini-3.5-flash-lite |
| RUNTIME | sandbox |

`CODING_MODEL` takes any `provider/model` the selected harness supports: `google/*`, `anthropic/*`, or `openai/*` for OpenCode; `anthropic/*` for Claude Code; `openai/*` for Codex; `devin/*` for Devin. An unsupported pairing is refused at config time with a message naming what the harness does support. Set `AGENT_HARNESS` to choose (default `opencode`).

Model ids retire — `gemini-2.0-flash` was shut down 2026-06-01, which is why the default moved. Verify current availability in your account; the checked-in model name is not a service guarantee. The assistant model used to edit this project is independent of the application's runtime models.

Tokens dominate the bill — roughly 20–40× the Cloudflare compute cost — so provider choice, not container tuning, is the lever that matters. See `docs/costs`.

Do not add provider credentials to the container. The container gets a dummy key (`DUMMY_PROVIDER_KEY`); the Sandbox Durable Object swaps in the real AI Gateway credential outside the container. Copy `apps/backend/.dev.vars.example` to the ignored `apps/backend/.dev.vars` for local configuration. `GITHUB_TOKEN` is attached by the Worker at the egress boundary for git traffic to the approved repo only, and is also used for Worker-side PR publishing; prefer a fine-grained token scoped to that repo. `GITHUB_WEBHOOK_SECRET` verifies acknowledgment-only webhook requests.

## Pinned versions

These versions are pinned because silent upgrades break the run contract:

| Pin | Coupling |
| --- | --- |
| `opencode-ai@1.18.31` (apps/backend/Dockerfile) | `parseOpencodeEvent` in `apps/backend/src/harness/opencode.ts` couples to its JSON event shape. Each harness's parser couples to its own CLI the same way — a stream-format change makes a run appear to hang rather than fail, so treat harness CLI bumps as breaking. |
| `@cloudflare/sandbox@0.12.9` (apps/backend/package.json) | Must match the base image tag `cloudflare/sandbox:0.12.9-opencode` |
| `CODING_MODEL` (`google/gemini-3.5-flash-lite`) | Provider model ids retire without warning |

Bumping any of them requires re-running the P2 live acceptance run before claiming it works.

## Slack

Shipped: `/shiba-ai-coworker <github-repo-url> <task>` (`POST /api/slack/command`) and `@shiba-ai-coworker` mention (`POST /api/slack/events`). Both HMAC-verify, queue a durable pending approval, and post a Block Kit card. Mentions need `SLACK_BOT_TOKEN`; empty token means no card and no run. Repo comes from a GitHub URL in the mention/thread, else `SLACK_CHANNEL_REPOS`, else an in-thread ask. Clicks resolve on the DO named by the card pointer (`default` for slash, `slack:{team}:{channel}:{thread_ts}` for mentions), gated by `SLACK_APPROVERS` (unset = nobody).

**`SLACK_APPROVERS` unset means nobody can approve from Slack.** That is deliberate: a valid signature authenticates Slack, not the human who clicked, and a Block Kit button in a public channel is clickable by every member.

No P3 live workspace verification is claimed. The P3 acceptance bar in `PLAN.md` §15 (Request URL verification with Access enabled, non-approver clicks refused with no container started, one run per burst, secret redaction) has not been exercised against a real workspace.

## Automations

Implemented: the trigger-rule engine (schedule with a five-field cron and 5-minute floor, missed ticks coalesced; GitHub, Slack, incoming-webhook, and manual triggers, OR'd together at most one run per event) plus the production fire path. Cloudflare Triggers run `*/5 * * * *`; Worker `scheduled()` ticks due schedules through the `Automations` Durable Object. Verified GitHub webhooks and `POST /api/automations/{id}/trigger` fan out the same way. A `runWhen` sentence is checked by TypeSafe Noul when `TYPESAFE_API_KEY` is set (noul ≥ 0.8 to run), else Workers AI YES/NO, and **fails closed**. Runs still queue an approval unless unattended is granted.

Safety, all three required together: approval by default, opt-in unattended mode refused unless opening a PR is the only mutation *and* the repo is allowlisted, and a daily run budget per automation. Kill switches: `enabled` per automation, `AUTOMATIONS_ENABLED` globally. Not verified live.

## Agent harnesses

Four, shipped in one pinned image: `opencode` (default, `opencode run --format json`), `claude-code` (`claude --print --output-format stream-json`), `codex` (`codex exec --json`), and `devin` (`devin -p`, Cognition's Devin CLI). Aider is not implemented. The dashboard's New Coding Task form picks the harness per run; `AGENT_HARNESS` is only the deployment default. The Agents view lists the image's CLIs with their pinned versions and credential status.

Claude Code and Codex are **API-key harnesses only**. Subscription credentials are deliberately not proxied: Anthropic's terms forbid third parties routing requests through Free, Pro, or Max plan credentials on behalf of users.

The credential invariant holds for every harness — the container receives a dummy key and the real one is injected outside it at the egress boundary. `allowedHosts` is narrowed per run to the *selected* harness's provider host plus git, never the union across harnesses. All four CLIs are in the shipped image (versions pinned in the `Dockerfile`); only OpenCode has been exercised against a live CLI — the Claude Code, Codex, and Devin event parsers are asserted from their documented stream formats until T10 proves otherwise.

The `devin` harness is not an AI Gateway provider: the CLI authenticates to Cognition's own backends (`api.devin.ai` for the control plane, `server.codeium.com` for inference on Pro accounts) with an account API key. Set `DEVIN_API_KEY` as a Worker secret (`npx wrangler secret put DEVIN_API_KEY --config apps/backend/wrangler.jsonc`); the container's `credentials.toml` carries a dummy and the egress forwarders swap in the real Bearer. Models are `devin/<alias>` — `devin/swe-2` is the default (free on Devin Pro); `DEVIN_MODEL` sets the deploy default.

The computer adapter deliberately refuses execution — `@cloudflare/computer` is preview-only, so Sandbox remains the default.

## What is and is not implemented

- Structured delegation input and SDK approval UI exist.
- Sandbox clone/configure/code/collect flow has unit tests using fakes.
- Provider traffic interception at the Sandbox egress boundary is implemented in `apps/backend/src/sandbox.ts`; there is no callback route to enable.
- Phase updates exist; token-level OpenCode JSON event streaming is partially surfaced via `streamProgress`.
- Per-user orchestrator routing exists (`getUserId` in `apps/backend/src/index.ts`); unauthenticated `/api/runs` returns 401. Full Access JWT verification is not implemented.
- Egress is deny-by-default: `interceptHttps` is on and `allowedHosts` admits only `generativelanguage.googleapis.com`, `github.com`, and `codeload.github.com`, narrowed per run by `approveHarnessEgress` to the selected harness's provider host plus git. The boundary is unit-tested but has not faced a live hostile run — still do not expose untrusted runs publicly on this basis alone.
- The GitHub credential is scoped to the run's repo: github.com egress is refused until `approveRepoScope` installs a forwarder for the approved `/owner/repo` path, and only GET/HEAD plus POST `git-upload-pack` pass — container pushes are refused even with the token.
- Cancellation is best-effort; clearing registry/history is not process cancellation or complete Durable Object erasure.
- GitHub publishing uses captured contents, not a lossless Git patch. File modes and large files need further work. Webhooks acknowledge events only.
- The parent result envelope exists (`RESULT_MARKER`); trust the parsed envelope, not the transport type — inspect transcripts, not just badges.
- `apps/backend/src/costs.ts` is gone — cost surfaces and application limits live in the docs (`apps/web/src/content/docs/docs/costs.md`, served at `/docs/costs`); they describe resources, not bills.

## Alternative runtimes

The computer adapter deliberately refuses execution. @cloudflare/computer's intended fit is persistent SQLite-backed VFS, typed Git, agent tools, and Worker-shell/container backends. It is not installed; verify current preview status before any implementation. Sandbox remains the default. celld is not a target because Workers compatibility does not supply managed Sandbox/Containers bindings.

## Troubleshooting and costs

Start with the troubleshooting docs. Static builds do not require cloud credentials. Live container execution does.

Cost surfaces include Workers, Workers AI planning inference, Durable Objects, Containers, AI Gateway/provider inference, and GitHub API quotas. No prices, free-tier suitability, or provisioning time guarantees are invented. Tokens dominate the bill (roughly 20–40× compute); review current limits and provider pricing before deployment.

## Official sources

- [Cloudflare Agents](https://developers.cloudflare.com/agents/)
- [Sandbox](https://developers.cloudflare.com/sandbox/)
- [Containers](https://developers.cloudflare.com/containers/)
- [Containers limits](https://developers.cloudflare.com/containers/platform/limits/)
- [AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Access](https://developers.cloudflare.com/cloudflare-one/access-controls/)
- [Computer package](https://www.npmjs.com/package/@cloudflare/computer)
- [Astro](https://docs.astro.build/)
- [Starlight](https://starlight.astro.build/)

## License

MIT. See LICENSE.
