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
| `AGENT_HARNESS` | `opencode` | Deployment fallback; a task can select a harness explicitly |
| `RUNTIME` | `sandbox` | Runtime adapter; current default is Cloudflare Sandbox |
| `INSTANCE_TYPE` | `standard-1` | Configured Cloudflare container size |
| `REQUIRE_ACCESS` | Wrangler default unset; live Alchemy stages set `1` | Require Access identity at the Worker boundary |

Model identifiers are defaults, not availability guarantees. Choose a currently available model for your account. Harness selection is implemented in `apps/backend/src/harness/` and has unit coverage; local OpenCode execution and successful model inference are separate claims (see dated [verification](/docs/readiness/)).

## Harnesses and credentials

The current source registry and Dockerfile include four harnesses: `opencode`, `claude-code`, `codex`, and `devin`. OpenCode supports Google, Anthropic, OpenAI, and xAI/Grok model providers (for xAI use `xai/<model>`); the provider selection, dummy key, and `api.x.ai` gateway egress are implemented and unit-tested. Cursor CLI is not yet an installed/selectable harness: its separate Cursor API-key path has not been wired through the approval-bound egress proxy. The dated `VERIFICATION.md` records OpenCode as the only harness exercised in the local end-to-end container run; that run's provider request returned 401. It records no cloud end-to-end run and no successful inference. Do not present unit tests or image binary checks as live harness acceptance.

OpenCode, Claude Code, and Codex provider traffic uses the account-owned AI Gateway path; configure provider credentials there. `AI_GATEWAY_TOKEN` is an optional Worker secret for gateway authentication. Devin is different: its API key is a Worker-side `DEVIN_API_KEY` secret, injected by the egress proxy for Devin hosts and not stored in the container. The dummy container key is not a real credential. Keep keys out of repository files, logs, and task text.

Subscription credentials (such as Claude or ChatGPT consumer subscriptions) are not the configured provider-key path. Use supported API credentials and check the provider and Cloudflare's current terms/configuration. The assistant/model used to edit this repository is independent of these application settings.

## Optional secrets

| Name | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Worker-side GitHub access for private clone and optional PR publishing; public diff-only runs can omit it |
| `GITHUB_WEBHOOK_SECRET` | HMAC verification for GitHub webhook automations |
| `AI_GATEWAY_TOKEN` | Optional gateway authorization credential |
| `DEVIN_API_KEY` | Required for Devin API access |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APPROVERS` | Optional Slack integration and approver allowlist |
| `SLACK_CHANNEL_REPOS` | Optional channel-to-repository mapping |
| `TYPESAFE_API_KEY` | Optional TypeSafe integration |

Local example:

```sh
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
# Edit locally; never commit secrets.
```

For the Alchemy deployment path, use `pnpm run bootstrap` to collect secrets in `.env`. Do not use `wrangler secret put` as though it configures the Alchemy deployment: its source of truth is `.env`. See [Deployment](/docs/deployment/).
