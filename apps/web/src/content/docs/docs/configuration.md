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
| `RUNTIME` | `sandbox` | Runtime adapter; current default is Cloudflare Sandbox |
| `INSTANCE_TYPE` | `standard-1` | Configured Cloudflare container size |
| `REQUIRE_ACCESS` | Wrangler default unset; live Alchemy stages set `1` | Require Access identity at the Worker boundary |

Model identifiers are defaults, not availability guarantees. Choose a currently available model for your account. Harness selection is implemented in `apps/backend/src/harness/` and has unit coverage; local OpenCode execution and successful model inference are separate claims (see dated [verification](/docs/readiness/)).

## Harnesses and credentials

The current source registry and Dockerfile include five harnesses: `opencode`, `claude-code`, `codex`, `devin`, and `grok`. OpenCode supports Google, Anthropic, OpenAI, and xAI/Grok model providers (for xAI use `xai/<model>`); the `grok` harness runs the Grok CLI headlessly (`--single`, `streaming-json`) pinned to the `api.x.ai` forwarder via `GROK_MODELS_BASE_URL`. Provider selection, the dummy key, and `api.x.ai` gateway egress are implemented and unit-tested. Cursor stays a remote-executor connection, not an installed harness: its API-key→token exchange stores tokens inside the container, which cannot hold the dummy-key invariant. The dated `VERIFICATION.md` records OpenCode as the only harness exercised in the local end-to-end container run; that run's provider request returned 401. It records no cloud end-to-end run and no successful inference. Do not present unit tests or image binary checks as live harness acceptance.

OpenCode, Claude Code, and Codex provider traffic uses the account-owned AI Gateway path; configure provider credentials there. `AI_GATEWAY_TOKEN` is an optional Worker secret for gateway authentication. Devin is different: its API key is a Worker-side `DEVIN_API_KEY` secret, injected by the egress proxy for Devin hosts and not stored in the container. The dummy container key is not a real credential. Keep keys out of repository files, logs, and task text.

### Claude subscription (opt-in)

Setting `SHIBA_CLAUDE_SUBSCRIPTION=1` registers a second Claude harness, `claude-subscription`, that drives the same `claude` binary against the operator's own subscription credential instead of AI Gateway. To connect an account, run `claude setup-token` on your own machine and store the printed token as a Worker secret — `CLAUDE_SUBSCRIPTION_TOKEN`, or `CLAUDE_SUBSCRIPTION_TOKEN_<ACCOUNT>` for a named account — then drive the lifecycle under `/api/auth/claude-subscription` (begin, verify, clear). Your own Anthropic plan terms apply; this deployment makes no use of anyone else's credential. The token is a deployment secret: it stays outside the sandbox, is attached only at the egress boundary, and appears in no log, command line, or UI response. Signing out (or revoking the token) stops in-flight subscription runs and refuses new ones.

Subscription credentials are not the default provider-key path — API credentials via AI Gateway are. The `claude-subscription` opt-in above is the deliberate exception: it exists for the single-tenant operator driving their own credential, and stays dark unless they set the flag. Check the provider's current terms before enabling it. The assistant/model used to edit this repository is independent of these application settings.

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
