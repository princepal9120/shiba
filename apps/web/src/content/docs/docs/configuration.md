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
| `PI_MODEL` | `anthropic/claude-sonnet-4-6` | Pi default model |
| `AGENT_HARNESS` | `opencode` | Deployment fallback; a task can select a harness explicitly |
| `SLACK_AGENT_HARNESS` | `AGENT_HARNESS`, then `claude-code` | Harness for Slack-originated runs (mentions, DMs, /shiba) |
| `SHIBA_CLAUDE_SUBSCRIPTION` | `0` in wrangler defaults | Set `1` to enable the deprecated `claude-subscription` harness — may violate Anthropic terms; prefer `claude-login` ([model auth](/docs/model-auth/)) |
| `MODEL_CREDENTIAL_KEY` | unset | 64 hex chars — enables per-user encrypted ChatGPT `auth.json` storage (Settings → Models) |
| `SHIBA_SINGLE_USER` | unset | Set `1` to allow legacy `CODEX_SUBSCRIPTION_AUTH_JSON` Worker-secret fallback for codex-subscription |
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
| `AGENT_MAILBOX` | `dev@tryshiba.dev` | Agent mailbox identity — the address the MCP `latest_verification` tool scans by default for OTP codes and magic sign-in links |
| `LOCAL_ADAPTER_TOKEN` | unset | Bearer token the operator daemon presents on `/api/local/*`; required for the surface to answer (dark otherwise) |
| `ROLE_MODEL_MAP` | unset | JSON map pinning a harness+model per delegation role, e.g. `{"fixer":{"harness":"opencode","model":"opencode-go/deepseek-v3.2"}}` |
| `ROLE_MODEL__ORCHESTRATOR` / `__EXPLORER` / `__FIXER` / `__REVIEWER` / `__DESIGNER` | unset | Per-role pin as `"harness/model"` or bare `"harness"` — consulted when the map has no entry for that role |
| `RUNTIME` | `sandbox` | Runtime adapter; current default is Cloudflare Sandbox |
| `INSTANCE_TYPE` | `standard-1` | Configured Cloudflare container size |
| `REQUIRE_ACCESS` | Wrangler default unset; live Alchemy stages set `1` | Require Access identity at the Worker boundary; if both `REQUIRE_ACCESS` and `ACCESS_AUD` are unset, only loopback hosts are unauthenticated |
| `BETTER_AUTH_URL` | unset | Canonical public dashboard URL (e.g. `https://app.tryshiba.dev`) for Better Auth cookie scope and origin checks; unset falls back to each request's own origin |

Model identifiers are defaults, not availability guarantees. Choose a currently available model for your account. Harness selection is implemented in `apps/backend/src/harness/` and has unit coverage; local OpenCode execution and successful model inference are separate claims (see dated [verification](/docs/readiness/)).

## Harnesses and credentials

The current source registry and Dockerfile include six always-on harnesses: `opencode`, `claude-code`, `codex`, `devin`, `grok`, and `pi`. OpenCode and Pi support Google, Anthropic, OpenAI, and xAI model providers; Pi runs headlessly with `--mode json` and its provider-specific API key env vars, while `grok` runs the Grok CLI with `--single` and streaming-json pinned to `api.x.ai` via `GROK_MODELS_BASE_URL`. Provider selection, dummy keys, and provider-host egress are implemented and unit-tested. Cursor stays a remote-executor connection, not an installed harness: its API-key→token exchange stores tokens inside the container, which cannot hold the dummy-key invariant. The dated `VERIFICATION.md` records OpenCode as the only harness exercised in the local end-to-end container run; that run's provider request returned 401. It records no cloud end-to-end run and no successful inference. Do not present unit tests or image binary checks as live harness acceptance.

OpenCode, Claude Code, Codex, and Pi provider traffic uses the account-owned AI Gateway path; configure provider credentials there. `AI_GATEWAY_TOKEN` is an optional Worker secret for gateway authentication. Keep keys out of repository files, logs, and task text.

### Claude subscription (deprecated opt-in)

`SHIBA_CLAUDE_SUBSCRIPTION` ships **`0` by default**. Setting it to `1` registers `claude-subscription`, which stores a `claude setup-token` at the Worker egress boundary — Anthropic does not permit third-party apps to collect or relay Claude.ai subscription tokens ([legal guidance](https://code.claude.com/docs/en/legal-and-compliance)). Prefer **`claude-login`**: the operator runs the official `claude` binary and `/login` inside their own sandbox; credentials stay on a per-user volume only they mount. See [Model authentication](/docs/model-auth/).

### ChatGPT subscription (per user, OSS self-host)

Set `MODEL_CREDENTIAL_KEY`, register an `openai-subscription` connection, and have each user complete **Sign in with ChatGPT** under **Settings → Models** (paste the `127.0.0.1` callback URL). Runs use `codex app-server` with a short-lived `ACCESS_TOKEN` only; refresh stays on the `ChatGptAuth` Durable Object. Details: [Model authentication](/docs/model-auth/).

### Codex subscription (opt-in)

Setting `SHIBA_CODEX_SUBSCRIPTION=1` registers `codex-subscription`, which drives the same `codex` binary against the operator's own ChatGPT subscription instead of AI Gateway. Per-user storage (`MODEL_CREDENTIAL_KEY`) or legacy `SHIBA_SINGLE_USER=1` + `CODEX_SUBSCRIPTION_AUTH_JSON` mounts real `auth.json` into each run's ephemeral `CODEX_HOME` (mode `0600`, removed at run end); the CLI refreshes from the container. Worker egress injection against `chatgpt.com` is not used (bot-challenge on Workers, 2026-10-19). Operator verify flow remains under `/api/auth/codex-subscription` (begin, verify, clear). Your own plan terms apply.

### Antigravity subscription (opt-in)

**Security limitation:** Antigravity still stores OAuth tokens in a container profile, not Worker-side custody. Repository processes running as the same user can read that file; directory permissions do not isolate them. Do not enable this harness for untrusted repositories. Task-run egress excludes `oauth2.googleapis.com` and `accounts.google.com`; OAuth exchange is confined to the separate sign-in sandbox, and token refresh during a task is blocked rather than silently broadening egress. Removing these hosts mitigates direct OAuth access but does not eliminate token theft or exfiltration through remaining allowed services. Full remediation requires Worker-side token custody and scoped egress-time injection.

Setting `SHIBA_ANTIGRAVITY_SUBSCRIPTION=1` registers `antigravity-subscription`, which drives the pinned `agy` ACP server against the operator's own Google subscription. There is no secret to store — the credential never touches the Worker. Connect an account by posting to `/api/auth/antigravity-subscription/begin` (optionally `{"account": "<name>"}`): shiba boots a dedicated auth sandbox, prepares the isolated profile (`0700` dirs, `auth.type=oauth-personal`, ambient Google credentials stripped from the launch environment), starts `agy` there, and returns the Google sign-in URL it prints. Sign in as the operator's own account; the browser lands on a `http://127.0.0.1:…/` redirect that fails in the browser — copy that URL verbatim and POST it to `/api/antigravity/callback` as `{"url": "<pasted>", "account": "<name>"}`. Shiba validates it is the pending flow's exact listener (same origin, same state, exactly one code-or-error) and forwards it into the container unmodified — no proxies, no redirects, no logging of the URL. Finish with `/verify`; signing in is not proof, the capability probe (token materialized in the profile) is. Clear via `/clear` destroys the auth sandbox. Your own plan terms apply.

### Cursor subscription (opt-in)

Setting `SHIBA_CURSOR_SUBSCRIPTION=1` opens the `cursor-subscription` connect lane, which connects the operator's own Cursor account instead of relying on a container-held `CURSOR_API_KEY`. To connect an account, create a Cursor Agent API key in cursor.com settings and store it as a Worker secret — `CURSOR_SUBSCRIPTION_TOKEN`, or `CURSOR_SUBSCRIPTION_TOKEN_<ACCOUNT>` for a named account — then drive the lifecycle under `/api/auth/cursor-subscription` (begin, verify, clear). The token is a deployment secret: it stays outside the sandbox, is attached only at the egress boundary on the two hosts the CLI calls (`api2.cursor.sh`, `repo2.cursor.sh`), and appears in no log, command line, or UI response. Verification exercises the key on the same wire runs use — the `api2.cursor.sh` credential exchange the CLI itself performs; a 401/403 marks the credential rejected. Signing out stops in-flight subscription runs and refuses new ones. Your own Cursor plan terms apply.

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
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APPROVERS` | Optional Slack integration and approver allowlist |
| `SLACK_CHANNEL_REPOS` | Optional channel-to-repository mapping |
| `TRIGGER_TOKEN` | Bearer token for `POST /api/trigger` (e.g. iPhone Apple Shortcuts); unset disables the route |
| `TYPESAFE_API_KEY` | Optional TypeSafe integration |
| `BETTER_AUTH_SECRET` | Turns on the built-in dashboard login: email+password accounts and signed-cookie sessions served at `/api/auth/*`, stored in the `AGENT_AUDIT` D1 database. The library requires >=32 characters. Generate with `openssl rand -base64 48`. Unset (or shorter) keeps the lane dark and the gate falls back to Access / fail-closed. The first account is the only account. Sign-up then closes. Reopen by clearing the `user` table. Access still takes precedence when configured |
| `BETTER_AUTH_BOOTSTRAP_TOKEN` | Setup token the first sign-up must send (`x-shiba-bootstrap-token`). On a public hostname, sign-up stays locked until this or `BETTER_AUTH_OWNER_EMAIL` is set. Loopback dev can create the first account without either |
| `BETTER_AUTH_OWNER_EMAIL` | Allowlisted email for that first account. Compared case-insensitively. Any other address is refused |

Local example:

```sh
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
# Edit locally; never commit secrets.
```

For the Alchemy deployment path, use `pnpm run bootstrap` to collect secrets in `.env`. Do not use `wrangler secret put` as though it configures the Alchemy deployment: its source of truth is `.env`. See [Deployment](/docs/deployment/).
