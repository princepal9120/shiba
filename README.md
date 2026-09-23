# Shiba

[![Site](https://img.shields.io/badge/Site-shiba--intern.pages.dev-0B9F95?style=flat-square&logo=cloudflarepages&logoColor=white)](https://shiba-intern.pages.dev/)
[![Documentation](https://img.shields.io/badge/Docs-shiba--intern.pages.dev%2Fdocs-teal?style=flat-square)](https://shiba-intern.pages.dev/docs/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

Shiba is an account-owned Cloudflare coding workspace: describe a GitHub task, review the proposed delegation, approve or reject it, and inspect a sandbox-generated diff. The repository includes a React dashboard and Astro/Starlight documentation, plus a Cloudflare Worker backend built around Agents and Sandbox containers running OpenCode.

**Status: local prototype.** No live end-to-end cloud run has been recorded yet (see `VERIFICATION.md`, PLAN.md T10). The Pages site below hosts only the static landing page, docs, and dashboard UI — it is not a verified live deployment of the coding pipeline.

**Static site (landing, docs, dashboard UI):** [https://shiba-intern.pages.dev/](https://shiba-intern.pages.dev/)
- **Landing Page:** [https://shiba-intern.pages.dev/](https://shiba-intern.pages.dev/)
- **Documentation:** [https://shiba-intern.pages.dev/docs/](https://shiba-intern.pages.dev/docs/)
- **Tasks Dashboard:** [https://shiba-intern.pages.dev/app/](https://shiba-intern.pages.dev/app/)

**Status: local prototype, not production-ready.** No live end-to-end cloud run is claimed. The deployed Cloudflare Pages site contains the static landing page at `/`, dashboard UI at `/app/`, and documentation at `/docs/`. This Pages deployment does not include the Worker backend, so it does not establish a live coding run. `VERIFICATION.md` records passing local typecheck, lint, tests, and build checks, while no live end-to-end cloud run has been performed. The backend remains a prototype until a dated run meets the P2 acceptance bar in `PLAN.md` §15: submit → approve → clone/code/collect with a diff that matches reality, rejection starting no container, honest failure exit codes, PRs with deletions shown as deleted, and peak memory measured.

Provider traffic is intercepted at the Sandbox egress boundary and forwarded through the account owner's AI Gateway binding — there is no provider callback route (the dead callback path was deleted; the forwarder and its route no longer exist).

## Deploy the UI

The existing `shiba-intern` Cloudflare Pages project hosts the static UI. Build the dashboard and docs, then deploy the assembled `public/` directory:

~~~sh
pnpm build
pnpm exec wrangler pages deploy public --project-name shiba-intern --branch main --commit-dirty=true
~~~

This flow deploys only the landing page, `/app/` dashboard, and `/docs/` documentation. The UI is currently static and has no Worker API or WebSocket proxy.

## Deploy the Worker backend

The full self-hosted flow provisions the Cloudflare Worker, Durable Objects, Containers, R2, and AI Gateway integration. It is separate from the Pages UI deployment:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/princepal9120/ai-intern)

### Prerequisites (in order)

1. Workers Paid plan (Durable Objects + Containers require it).
2. An AI Gateway with a stored provider key ([BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)) — the key never enters this repo or the container.
3. Cloudflare Access on the Worker route, **with a bypass for `/api/slack/events`, `/api/slack/command`, and `/api/github/webhook`** (Slack and GitHub cannot complete an Access login). The Worker exempts exactly those paths; anything else under `/api/slack/` is still gated.
4. `GITHUB_TOKEN` secret — required for PR publishing, so effectively required for Slack.
5. Optional Slack app — see the Slack section below.

**Resolve the readiness blockers before deploying.** Confirm Workers/Containers plan eligibility, quotas, and account billing in current Cloudflare documentation. Configure an account-owned AI Gateway with a stored Google BYOK key or Unified Billing, and select an available model id (model ids retire — see Configuration).

After implementing and validating the missing security boundaries, the self-hosted Worker is deployed with Alchemy — `alchemy.run.ts` declares the same stack as `wrangler.jsonc`:

~~~sh
# One-time: credentials + remote state
npx alchemy provider cloudflare token      # mint an API token into the default profile
#   or: export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
# Optional — only for the remote state store (local filesystem state is the default):
npx alchemy provider cloudflare bootstrap  # needs Secrets Store scope on the token

# Secrets — bound only when set in the deploy environment (see alchemy.run.ts)
export GITHUB_TOKEN=...
export GITHUB_WEBHOOK_SECRET=...

pnpm build
pnpm deploy            # alchemy deploy — the live stage adopts the
                       # wrangler-managed worker/resources in place automatically
pnpm deploy:preview    # alchemy plan (dry-run)
pnpm deploy:destroy    # alchemy destroy
~~~

Rollback to wrangler (same bindings, unchanged): `npx wrangler login`, preview via `pnpm deploy:preview:wrangler`, ship via `npx wrangler deploy`.

Stage selection goes through `$ALCHEMY_STAGE` only (e.g. `ALCHEMY_STAGE=test-x pnpm deploy` gives the worker/container a `-test-x` suffix); do not pass `--stage` — resource names are derived from the env var and a diverging flag fails loudly instead of colliding with live. Local deploys use the filesystem state store by default; `ALCHEMY_STATE_BACKEND=cloudflare` opts into the remote State Store after the one-time `bootstrap` above (needs a token with the Secrets Store scope).

These commands change the operator's account. They are separate from the Pages-only command above. `pnpm deploy` does not automatically build the static assets first.

Protect every reachable hostname with Cloudflare Access or equivalent authentication. An obscure URL is not access control. Browser approval is not route authorization. Review the security docs before live operation.

## Local quickstart

Requirements: Node.js **22.12.0+**, pnpm **10.0.0+**. A Docker CLI is also
required for Wrangler container image packaging; a missing Docker daemon
fails even the local dry run.

~~~sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
pnpm docs:preview
~~~

Open **http://localhost:5173/** for the landing page, **http://localhost:5173/app/** for the dashboard UI, or **http://localhost:4321/docs/** to read the documentation with search.

- Dashboard and landing page: `pnpm dev` (port 5173; no Worker API proxy).
- Docs editing: pnpm docs:dev (port 4321/docs/; search requires a production build).
- Built Worker/assets: pnpm build, then npx wrangler dev. Containers require a compatible local engine; startup may fail without it.
- Local Worker deployment packaging: npx wrangler deploy --dry-run. This is not a deployment or proof of a live coding run.

## Documentation

The documentation site at `/docs/` includes setup, configuration, local development, dashboard usage, deployment, GitHub integration, security, architecture, API reference, troubleshooting, cost surfaces, contributing, and an end-to-end acceptance checklist.

Source entry: [docs index](web/src/content/docs/index.md). Content lives in web/src/content/docs/docs/. The root build runs Vite first, builds Astro into web/dist, then copies web/dist into public/ and verifies local links, anchors, assets, and Pagefind output.

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

Non-secret defaults in wrangler.jsonc:

| Setting | Default |
| --- | --- |
| GATEWAY_ID | default |
| ORCHESTRATOR_MODEL | @cf/meta/llama-3.1-8b-instruct |
| CODING_MODEL | google/gemini-3.5-flash-lite |
| RUNTIME | sandbox |

`CODING_MODEL` takes any `provider/model` the selected harness supports: `google/*`, `anthropic/*`, or `openai/*` for OpenCode; `anthropic/*` for Claude Code; `openai/*` for Codex; `devin/*` for Devin. An unsupported pairing is refused at config time with a message naming what the harness does support. Set `AGENT_HARNESS` to choose (default `opencode`).

Model ids retire — `gemini-2.0-flash` was shut down 2026-06-01, which is why the default moved. Verify current availability in your account; the checked-in model name is not a service guarantee. The assistant model used to edit this project is independent of the application's runtime models.

Tokens dominate the bill — roughly 20–40× the Cloudflare compute cost — so provider choice, not container tuning, is the lever that matters. See `docs/costs`.

Do not add provider credentials to the container. The container gets a dummy key (`DUMMY_PROVIDER_KEY`); the Sandbox Durable Object swaps in the real AI Gateway credential outside the container. Copy .dev.vars.example to the ignored .dev.vars for local configuration. `GITHUB_TOKEN` is attached by the Worker at the egress boundary for git traffic to the approved repo only, and is also used for Worker-side PR publishing; prefer a fine-grained token scoped to that repo. `GITHUB_WEBHOOK_SECRET` verifies acknowledgment-only webhook requests.

## Pinned versions

These versions are pinned because silent upgrades break the run contract:

| Pin | Coupling |
| --- | --- |
| `opencode-ai@1.18.31` (Dockerfile) | `parseOpencodeEvent` in `src/harness/opencode.ts` couples to its JSON event shape. Each harness's parser couples to its own CLI the same way — a stream-format change makes a run appear to hang rather than fail, so treat harness CLI bumps as breaking. |
| `@cloudflare/sandbox@0.12.9` (package.json) | Must match the base image tag `cloudflare/sandbox:0.12.9-opencode` |
| `CODING_MODEL` (`google/gemini-3.5-flash-lite`) | Provider model ids retire without warning |

Bumping any of them requires re-running the P2 live acceptance run before claiming it works.

## Slack

Shipped: `/ai-intern <github-repo-url> <task>` (`POST /api/slack/command`) and `@mention` (`POST /api/slack/events`). Both HMAC-verify, queue a durable pending approval, and post a Block Kit card. Mentions need `SLACK_BOT_TOKEN`; empty token means no card and no run. Repo comes from a GitHub URL in the mention/thread, else `SLACK_CHANNEL_REPOS`, else an in-thread ask. Clicks resolve on the DO named by the card pointer (`default` for slash, `slack:{team}:{channel}:{thread_ts}` for mentions), gated by `SLACK_APPROVERS` (unset = nobody).

**`SLACK_APPROVERS` unset means nobody can approve from Slack.** That is deliberate: a valid signature authenticates Slack, not the human who clicked, and a Block Kit button in a public channel is clickable by every member.

No P3 live workspace verification is claimed. The P3 acceptance bar in `PLAN.md` §15 (Request URL verification with Access enabled, non-approver clicks refused with no container started, one run per burst, secret redaction) has not been exercised against a real workspace.

## Automations

Implemented: the trigger-rule engine (schedule with a five-field cron and 5-minute floor, missed ticks coalesced; GitHub, Slack, incoming-webhook, and manual triggers, OR'd together at most one run per event) plus the production fire path. Cloudflare Triggers run `*/5 * * * *`; Worker `scheduled()` ticks due schedules through the `Automations` Durable Object. Verified GitHub webhooks and `POST /api/automations/{id}/trigger` fan out the same way. A `runWhen` sentence is checked by TypeSafe Noul when `TYPESAFE_API_KEY` is set (noul ≥ 0.8 to run), else Workers AI YES/NO, and **fails closed**. Runs still queue an approval unless unattended is granted.

Safety, all three required together: approval by default, opt-in unattended mode refused unless opening a PR is the only mutation *and* the repo is allowlisted, and a daily run budget per automation. Kill switches: `enabled` per automation, `AUTOMATIONS_ENABLED` globally. Not verified live.

## Agent harnesses

Four, shipped in one pinned image: `opencode` (default, `opencode run --format json`), `claude-code` (`claude --print --output-format stream-json`), `codex` (`codex exec --json`), and `devin` (`devin -p`, Cognition's Devin CLI). Aider is not implemented. The dashboard's New Coding Task form picks the harness per run; `AGENT_HARNESS` is only the deployment default. The Agents view lists the image's CLIs with their pinned versions and credential status.

Claude Code and Codex are **API-key harnesses only**. Subscription credentials are deliberately not proxied: Anthropic's terms forbid third parties routing requests through Free, Pro, or Max plan credentials on behalf of users.

The credential invariant holds for every harness — the container receives a dummy key and the real one is injected outside it at the egress boundary. `allowedHosts` is narrowed per run to the *selected* harness's provider host plus git, never the union across harnesses. All four CLIs are in the shipped image (versions pinned in the `Dockerfile`); only OpenCode has been exercised against a live CLI — the Claude Code, Codex, and Devin event parsers are asserted from their documented stream formats until T10 proves otherwise.

The `devin` harness is not an AI Gateway provider: the CLI authenticates to Cognition's own backends (`api.devin.ai` for the control plane, `server.codeium.com` for inference on Pro accounts) with an account API key. Set `DEVIN_API_KEY` as a Worker secret (`npx wrangler secret put DEVIN_API_KEY`); the container's `credentials.toml` carries a dummy and the egress forwarders swap in the real Bearer. Models are `devin/<alias>` — `devin/swe-2` is the default (free on Devin Pro); `DEVIN_MODEL` sets the deploy default.

The computer adapter deliberately refuses execution — `@cloudflare/computer` is preview-only, so Sandbox remains the default.

## What is and is not implemented

- Structured delegation input and SDK approval UI exist.
- Sandbox clone/configure/code/collect flow has unit tests using fakes.
- Provider traffic interception at the Sandbox egress boundary is implemented in `src/sandbox.ts`; there is no callback route to enable.
- Phase updates exist; token-level OpenCode JSON event streaming is partially surfaced via `streamProgress`.
- Per-user orchestrator routing exists (`getUserId` in `src/index.ts`); unauthenticated `/api/runs` returns 401. Full Access JWT verification is not implemented.
- Egress is deny-by-default: `interceptHttps` is on and `allowedHosts` admits only `generativelanguage.googleapis.com`, `github.com`, and `codeload.github.com`, narrowed per run by `approveHarnessEgress` to the selected harness's provider host plus git. The boundary is unit-tested but has not faced a live hostile run — still do not expose untrusted runs publicly on this basis alone.
- The GitHub credential is scoped to the run's repo: github.com egress is refused until `approveRepoScope` installs a forwarder for the approved `/owner/repo` path, and only GET/HEAD plus POST `git-upload-pack` pass — container pushes are refused even with the token.
- Cancellation is best-effort; clearing registry/history is not process cancellation or complete Durable Object erasure.
- GitHub publishing uses captured contents, not a lossless Git patch. File modes and large files need further work. Webhooks acknowledge events only.
- The parent result envelope exists (`RESULT_MARKER`); trust the parsed envelope, not the transport type — inspect transcripts, not just badges.
- `src/costs.ts` is gone — cost surfaces and application limits live in the docs (`web/src/content/docs/docs/costs.md`, served at `/docs/costs`); they describe resources, not bills.

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
