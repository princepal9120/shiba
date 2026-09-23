---
title: Configuration
description: Current runtime variables, optional secrets, and model boundaries.
---

Non-secret defaults live in backend/wrangler.jsonc. Local overrides and secrets may be placed in the ignored .dev.vars file. Production secrets are set through Wrangler; .dev.vars is not uploaded as production configuration.

| Setting | Default | Purpose |
| --- | --- | --- |
| GATEWAY_ID | default | Account-owned AI Gateway selected by the AI binding |
| ORCHESTRATOR_MODEL | @cf/meta/llama-3.1-8b-instruct | Parent planning via Workers AI |
| CODING_MODEL | google/gemini-3.5-flash-lite | OpenCode coding model; validated against the selected harness |
| CLAUDE_CODE_MODEL | anthropic/claude-sonnet-4-6 | Coding model when the claude-code harness is selected |
| CODEX_MODEL | openai/gpt-5.3-codex | Coding model when the codex harness is selected |
| RUNTIME | sandbox | Default adapter; computer refuses execution |
| AGENT_HARNESS | opencode | Default harness; a run may override it from the dashboard |

Provider traffic is intercepted at Sandbox egress. There is no public `/api/provider` callback. Keep provider keys in AI Gateway BYOK; they never enter the container.

Select a currently available model in your account. The checked-in default is not an availability guarantee. The assistant model used to edit this repository is independent of these application settings; an anonymous model name is not a usable endpoint.

### Harnesses and subscription credentials

`opencode`, `claude-code`, and `codex` are supported; each run may pick a different provider model (`google/*`, `anthropic/*`, `openai/*`) validated against the harness. Subscription credentials are deliberately not supported: Claude Pro/Max OAuth tokens and ChatGPT Plus/Pro credentials may not be routed through a third-party service on a user's behalf. The supported path is a provider **API key** stored as BYOK on your own AI Gateway — the container receives only a dummy key and real credentials are injected at egress. Cursor and Devin have no published headless CLI with a compatible credential model, so no harness exists for them.

## Optional secrets

| Name | Purpose |
| --- | --- |
| GITHUB_TOKEN | Worker-side PR publishing, not private clone access |
| GITHUB_WEBHOOK_SECRET | HMAC verification for acknowledgment-only webhooks |

~~~sh
cp backend/.dev.vars.example backend/.dev.vars
# Edit locally; never commit secrets.
~~~

After resolving [readiness blockers](/docs/readiness/), production operators may configure:

~~~sh
npx wrangler secret put GITHUB_TOKEN --config backend/wrangler.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config backend/wrangler.jsonc
~~~

These commands modify your Cloudflare account. They are not local validation steps. Keep actual provider keys in the supported gateway credential store, never in container configuration. See [Deployment](/docs/deployment/#ai-gateway-setup).

