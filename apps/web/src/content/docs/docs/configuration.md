---
title: Configuration
description: Current runtime defaults, optional secrets, and what harness verification means.
---

Non-secret defaults are in `apps/backend/wrangler.jsonc` and `alchemy.run.ts`. For local Wrangler runs, copy `apps/backend/.dev.vars.example` to the ignored `apps/backend/.dev.vars`. The Alchemy bootstrap stores deployment configuration/secrets in root `.env` (gitignored, mode 0600); inspect `scripts/setup.mjs` and `alchemy.run.ts`. Neither file belongs in version control. `.dev.vars` is not uploaded as production configuration.

| Setting | Default / status | Purpose |
| --- | --- | --- |
| `GATEWAY_ID` | `default` | Account-owned AI Gateway selected through the Workers AI binding |
| `ORCHESTRATOR_MODEL` | `@cf/meta/llama-3.1-8b-instruct` | Parent planning via Workers AI |
| `CODING_MODEL` | `google/gemini-3.5-flash-lite` | OpenCode default coding model; also accepts `xai/<model>` for Grok |
| `CLAUDE_CODE_MODEL` | `anthropic/claude-sonnet-4-6` | Claude Code default model |
| `CODEX_MODEL` | `openai/gpt-5.3-codex` | Codex default model |
| `DEVIN_MODEL` | `devin/swe-2` | Devin default model |
| `GROK_MODEL` | `xai/grok-4.6` | Grok default model; medium reasoning effort |
| `AGENT_HARNESS` | `opencode` | Deployment fallback; a task can select a harness explicitly |
| `SLACK_AGENT_HARNESS` | `AGENT_HARNESS`, then `claude-code` | Harness for Slack-originated runs (mentions, DMs, /shiba) |
| `SHIBA_CLAUDE_SUBSCRIPTION` | unset | Set `1` to enable the opt-in `claude-subscription` harness (below) |
| `CLAUDE_SUBSCRIPTION_MODEL` | `anthropic-subscription/claude-sonnet-4-6` | `claude-subscription` default model |
| `SHIBA_CODEX_SUBSCRIPTION` | unset | Set `1` to enable the opt-in `codex-subscription` harness (below) |
| `CODEX_SUBSCRIPTION_MODEL` | `openai-subscription/gpt-5.3-codex` | `codex-subscription` default model |
| `SHIBA_ANTIGRAVITY_SUBSCRIPTION` | unset | Set `1` to enable the opt-in `antigravity-subscription` harness (below) |
| `ANTIGRAVITY_SUBSCRIPTION_MODEL` | `google-subscription/gemini-3-pro` | `antigravity-subscription` default model |
| `SHIBA_CURSOR_SUBSCRIPTION` | unset | Set `1` to open the opt-in `cursor-subscription` connect lane (below) |
| `CURSOR_SUBSCRIPTION_MODEL` | `cursor/auto` | `cursor-subscription` model override |
| `SHIBA_DEVIN_SUBSCRIPTION` | unset | Set `1` to open the opt-in `devin-subscription` connect lane (below) |
| `DEVIN_SUBSCRIPTION_MODEL` | `devin/swe-2` | `devin-subscription` model override |
| `SHIBA_LOCAL_RUNTIME` | unset | Set `1` to enable the opt-in `local` runtime (below) — dashboards can queue runs that execute on an operator machine |
| `LOCAL_ADAPTER_TOKEN` | unset | Bearer token the operator daemon presents on `/api/local/*`; required for the surface to answer (dark otherwise) |
| `ROLE_MODEL_MAP` | unset | JSON map pinning a harness+model per delegation role, e.g. `{"fixer":{"harness":"opencode","model":"opencode-go/deepseek-v3.2"}}` |
| `ROLE_MODEL__ORCHESTRATOR` / `__EXPLORER` / `__FIXER` / `__REVIEWER` / `__DESIGNER` | unset | Per-role pin as `"harness/model"` or bare `"harness"` — consulted when the map has no entry for that role |
| `RUNTIME` | `sandbox` | Runtime adapter; current default is Cloudflare Sandbox |
| `INSTANCE_TYPE` | `standard-1` | Configured Cloudflare container size |
| `REQUIRE_ACCESS` | Wrangler default unset; live Alchemy stages set `1` | Require Access identity at the Worker boundary; if both `REQUIRE_ACCESS` and `ACCESS_AUD` are unset, only loopback hosts are unauthenticated |

Model identifiers are defaults, not availability guarantees. Choose a currently available model for your account. Harness selection is implemented in `apps/backend/src/harness/` and has unit coverage; local OpenCode execution and successful model inference are separate claims (see dated [verification](/docs/readiness/)).

## Harnesses and credentials

The current source registry and Dockerfile include five harnesses: `opencode`, `claude-code`, `codex`, `devin`, and `grok`. OpenCode supports Google, Anthropic, OpenAI, and xAI/Grok model providers (for xAI use `xai/<model>`); the `grok` harness runs the Grok CLI headlessly (`--single`, `streaming-json`) pinned to the `api.x.ai` forwarder via `GROK_MODELS_BASE_URL`. Provider selection, the dummy key, and `api.x.ai` gateway egress are implemented and unit-tested. Cursor stays a remote-executor connection, not an installed harness: its API-key→token exchange stores tokens inside the container, which cannot hold the dummy-key invariant. The dated `VERIFICATION.md` records OpenCode as the only harness exercised in the local end-to-end container run; that run's provider request returned 401. It records no cloud end-to-end run and no successful inference. Do not present unit tests or image binary checks as live harness acceptance.

OpenCode, Claude Code, and Codex provider traffic uses the account-owned AI Gateway path; configure provider credentials there. `AI_GATEWAY_TOKEN` is an optional Worker secret for gateway authentication. Devin is different: its API key is a Worker-side `DEVIN_API_KEY` secret, injected by the egress proxy for Devin hosts and not stored in the container. The dummy container key is not a real credential. Keep keys out of repository files, logs, and task text.

### Claude subscription (opt-in)

Setting `SHIBA_CLAUDE_SUBSCRIPTION=1` registers a second Claude harness, `claude-subscription`, that drives the same `claude` binary against the operator's own subscription credential instead of AI Gateway. To connect an account, run `claude setup-token` on your own machine and store the printed token as a Worker secret — `CLAUDE_SUBSCRIPTION_TOKEN`, or `CLAUDE_SUBSCRIPTION_TOKEN_<ACCOUNT>` for a named account — then drive the lifecycle under `/api/auth/claude-subscription` (begin, verify, clear). Your own Anthropic plan terms apply; this deployment makes no use of anyone else's credential. The token is a deployment secret: it stays outside the sandbox, is attached only at the egress boundary, and appears in no log, command line, or UI response. Signing out (or revoking the token) stops in-flight subscription runs and refuses new ones.

### Codex subscription (opt-in)

Setting `SHIBA_CODEX_SUBSCRIPTION=1` registers `codex-subscription`, which drives the same `codex` binary against the operator's own ChatGPT subscription instead of AI Gateway. Codex's credential is directory-shaped: run `codex login` on your own machine and store the resulting `~/.codex/auth.json` contents verbatim as a Worker secret — `CODEX_SUBSCRIPTION_AUTH_JSON`, or `CODEX_SUBSCRIPTION_AUTH_JSON_<ACCOUNT>` for a named account — then drive the lifecycle under `/api/auth/codex-subscription` (begin, verify, clear). In the sandbox the run's `CODEX_HOME` is a per-account shadow holding a stub `auth.json` as a real file plus symlinks into the shared home (sessions, caches, the install) — a conversation thread survives an account switch while each account revokes independently. The real tokens never enter the container: the dedicated `chatgpt.com` egress branch attaches `Bearer` + `chatgpt-account-id` at the boundary, token refresh hosts are not admitted (an expired token fails the run honestly — re-store the secret), and the credential appears in no sandbox file, argv, log, or UI response. Your own plan terms apply.

### Antigravity subscription (opt-in)

Setting `SHIBA_ANTIGRAVITY_SUBSCRIPTION=1` registers `antigravity-subscription`, which drives the pinned `agy` ACP server against the operator's own Google subscription. There is no secret to store — the credential never touches the Worker. Connect an account by posting to `/api/auth/antigravity-subscription/begin` (optionally `{"account": "<name>"}`): shiba boots a dedicated auth sandbox, prepares the isolated profile (`0700` dirs, `auth.type=oauth-personal`, ambient Google credentials stripped from the launch environment), starts `agy` there, and returns the Google sign-in URL it prints. Sign in as the operator's own account; the browser lands on a `http://127.0.0.1:…/` redirect that fails in the browser — copy that URL verbatim and POST it to `/api/antigravity/callback` as `{"url": "<pasted>", "account": "<name>"}`. Shiba validates it is the pending flow's exact listener (same origin, same state, exactly one code-or-error) and forwards it into the container unmodified — no proxies, no redirects, no logging of the URL. Finish with `/verify`; signing in is not proof, the capability probe (token materialized in the profile) is. Clear via `/clear` destroys the auth sandbox. Your own plan terms apply.

### Cursor subscription (opt-in)

Setting `SHIBA_CURSOR_SUBSCRIPTION=1` opens the `cursor-subscription` connect lane, which connects the operator's own Cursor account instead of relying on a container-held `CURSOR_API_KEY`. To connect an account, create a Cursor Agent API key in cursor.com settings and store it as a Worker secret — `CURSOR_SUBSCRIPTION_TOKEN`, or `CURSOR_SUBSCRIPTION_TOKEN_<ACCOUNT>` for a named account — then drive the lifecycle under `/api/auth/cursor-subscription` (begin, verify, clear). The token is a deployment secret: it stays outside the sandbox, is attached only at the egress boundary on the two hosts the CLI calls (`api2.cursor.sh`, `repo2.cursor.sh`), and appears in no log, command line, or UI response. Verification exercises the key on the same wire runs use — the `api2.cursor.sh` credential exchange the CLI itself performs; a 401/403 marks the credential rejected. Signing out stops in-flight subscription runs and refuses new ones. Your own Cursor plan terms apply.

### Devin subscription (opt-in)

Setting `SHIBA_DEVIN_SUBSCRIPTION=1` opens the `devin-subscription` connect lane, which connects the operator's own Devin account credential instead of the deployment-wide `DEVIN_API_KEY`. To connect an account, run `devin auth login` on your own machine and store the resulting API key/session token as a Worker secret — `DEVIN_SUBSCRIPTION_TOKEN`, or `DEVIN_SUBSCRIPTION_TOKEN_<ACCOUNT>` for a named account — then drive the lifecycle under `/api/auth/devin-subscription` (begin, verify, clear). The token stays outside the sandbox and is attached only at the egress boundary (`Bearer` on `api.devin.ai`, the CLI's own `Basic` form on `server.codeium.com`); verification issues `GET /v3/self` through that same branch — a 401/403 marks the credential rejected. Your own Devin plan terms apply.

Subscription credentials are not the default provider-key path — API credentials via AI Gateway are. The `claude-subscription` opt-in above is the deliberate exception: it exists for the single-tenant operator driving their own credential, and stays dark unless they set the flag. Check the provider's current terms before enabling it. The assistant/model used to edit this repository is independent of these application settings.

### Local runtime (opt-in)

Setting `SHIBA_LOCAL_RUNTIME=1` and provisioning the `LOCAL_ADAPTER_TOKEN` secret registers a third `RuntimeAdapter` name, `local`, alongside `sandbox`. A run with `runtime: "local"` still mints the same approval card and still computes its verdict with `harness.verify` — the gate does not relax because the work is local. What changes is where step 5 executes: instead of booting a sandbox, the Worker posts a schema-checked envelope to the `LocalDispatch` DO and an operator-side daemon claims it over an authenticated outbound connection.

The daemon is `scripts/shiba-local-daemon.mjs` — a single dependency-free Node ≥20 script. On the operator machine (macOS or Linux):

```sh
export SHIBA_WORKER_URL=https://<your-worker>.workers.dev
export LOCAL_ADAPTER_TOKEN=<same secret the Worker knows>
node scripts/shiba-local-daemon.mjs            # poll loop; --once for a single cycle
```

The agent CLIs (`opencode`, `claude`, `codex`) must be on the daemon's `PATH` and authenticated in the operator's own terminal — `claude auth login`, `codex login`, Google sign-in happen locally; no credential ever transits the Worker, egress, or a container. Runs materialize under `~/.shiba-local/runs/<sandboxId>/` (`work/` for the clone, `home/` for `HOME`); provider config bodies reference `${OPENCODE_API_KEY}`-style placeholders resolved from the operator's environment, and the dummy key is stripped entirely. Process leases under `leases/run/<id>.lease` keep a second daemon from double-claiming; dead workspaces are reaped at startup.

Intake is provably dashboard-only: `runtime: "local"` is refused at intake on every chat surface (Slack, email, MCP, automations) because only the authenticated `/api/runs` handler stamps the `X-Shiba-Intake: dashboard` voucher `queueSlackRun` requires. Harnesses opt in via `supportedRuntimes` — `opencode`, `claude-code`, `codex` declare `["sandbox", "local"]`; every other harness refuses local dispatch. Git publish stays Worker-side: the daemon returns receipts plus the diff, and the existing publish path opens the PR. Cancelling an approved-but-unclaimed run is supported (`POST /cancel` settles it); a daemon that dies mid-run is recoverable — stale claims are reaped after 45 minutes.

## Optional secrets

| Name | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Worker-side GitHub access for private clone and optional PR publishing; public diff-only runs can omit it |
| `GITHUB_WEBHOOK_SECRET` | HMAC verification for GitHub webhook automations |
| `GITHUB_PROJECT_TOKEN`, `GITHUB_PROJECT_NUMBER` | Optional Projects v2 board sync — a PAT with `project` scope and the board number; published PRs are added to the board and moved to "In review" |
| `AI_GATEWAY_TOKEN` | Optional gateway authorization credential |
| `DEVIN_API_KEY` | Required for Devin API access |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APPROVERS` | Optional Slack integration and approver allowlist |
| `SLACK_CHANNEL_REPOS` | Optional channel-to-repository mapping |
| `TRIGGER_TOKEN` | Bearer token for `POST /api/trigger` (e.g. iPhone Apple Shortcuts); unset disables the route |
| `TYPESAFE_API_KEY` | Optional TypeSafe integration |

Local example:

```sh
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
# Edit locally; never commit secrets.
```

For the Alchemy deployment path, use `pnpm run bootstrap` to collect secrets in `.env`. Do not use `wrangler secret put` as though it configures the Alchemy deployment: its source of truth is `.env`. See [Deployment](/docs/deployment/).
