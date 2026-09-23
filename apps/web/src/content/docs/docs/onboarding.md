---
title: End-to-End Onboarding & Setup
description: Complete step-by-step setup guide for deploying and running AI Coworker according to PLAN.md.
---

This guide provides the **complete, end-to-end setup walkthrough** for deploying and operating AI Coworker (Shiba) on your own Cloudflare account, adhering strictly to the architecture, security boundaries, and operational invariants specified in **`PLAN.md`**.

---

## 1. Prerequisites Checklist

Before provisioning resources or writing configuration, ensure you have:

1. **Cloudflare Account with Workers Paid**:
   - The **Workers Paid plan** ($5/month) is **mandatory**. Durable Objects and Containers require Workers Paid.
   - Plan includes 25 GiB-h memory, 375 vCPU-minutes, 200 GB-h container disk, and 400,000 DO GB-seconds.
2. **Local Development Tools**:
   - **Node.js** >= 22.12.0
   - **pnpm** >= 10.0.0
   - **Docker** or **OrbStack** daemon running locally (required by Wrangler to package the container image `./Dockerfile`).
3. **Target GitHub Repository**:
   - A public or private GitHub repository where tasks will be executed.
   - For live validation, start with a throwaway test repository.

---

## 2. Infrastructure Setup (PLAN.md §5, T1–T2)

### Durable Objects SQLite Storage
AI Coworker requires SQLite-backed storage for both the parent orchestrator (`CodingOrchestrator`) and the container sandbox (`Sandbox`).

In `apps/backend/wrangler.jsonc`, verify the migration definition uses `new_sqlite_classes`:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["CodingOrchestrator", "OpenCodeAgent", "Sandbox"]
  }
]
```

:::caution[Historical Migrations]
Cloudflare rejects modifications to historical migrations. If your Worker was previously deployed with `new_classes`, add a `v2` migration tag instead of modifying `v1` in place.
:::

### Container Sizing and Concurrency
Containers default to `lite` (256 MiB RAM), which causes out-of-memory (OOM) crashes when running a coding CLI and git clone.

AI Coworker configures `standard-1` (1 vCPU, 4 GiB RAM, 10 GB disk) with concurrency capped at 5:

```jsonc
"containers": [
  {
    "class_name": "Sandbox",
    "name": "shiba-ai-coworker-sandbox",
    "image": "./Dockerfile",
    "instance_type": "standard-1",
    "max_instances": 5
  }
]
```

:::note[Ceiling Warning]
Cloudflare's maximum container profile is **`standard-4`** (4 vCPU / 12 GiB RAM / 20 GB disk). Massive multi-gigabyte monorepo builds are out of reach; tasks should be scoped accordingly.
:::

---

## 3. AI Gateway & BYOK Keys (PLAN.md §5 & §8)

AI Coworker follows a strict security invariant: **real provider API keys never enter the container and never enter the Worker code.**

Instead, provider calls are intercepted at the Sandbox egress proxy and authenticated via Cloudflare AI Gateway's **Bring Your Own Keys (BYOK)** credential store.

### Configuration Steps:
1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com/) and navigate to **AI** > **AI Gateway**.
2. Create a gateway or use the default (ID: `default`).
3. Under Gateway Settings, configure **Stored Provider Keys (BYOK)**:
   - **Google AI Studio**: Add your Google Gemini API key (supports `google/gemini-3.8-flash` and `google/gemini-3.5-flash-lite`).
   - **Anthropic**: Add your Anthropic API key (supports `anthropic/claude-sonnet-4-6` for the `claude-code` harness).
   - **OpenAI**: Add your OpenAI API key (supports `openai/gpt-5.3-codex` for the `codex` harness).
4. Inside the container, CLIs run with a non-secret dummy key (`DUMMY_PROVIDER_KEY`). When OpenCode, Claude Code, or Codex makes an API request, the Worker's Sandbox egress proxy catches the request and forwards it through the AI Gateway, injecting the stored key securely.

---

## 4. Cloudflare Access & Mandatory Webhook Bypasses (PLAN.md §6 & §9)

### Defense-in-Depth Layer 1: Cloudflare Access
Protect your Worker application using Cloudflare Zero Trust Access:
1. In Cloudflare Zero Trust, create an **Access Application** protecting `https://<your-worker-domain>/`.
2. Add an **Allow Policy** restricting access to authorized team emails or identity providers.

### Defense-in-Depth Layer 2: Mandatory Webhook Bypass Policy
:::danger[Critical Bypass Requirement]
Slack and GitHub cannot complete an interactive Cloudflare Access browser login! If you do not create a bypass policy, Slack mentions and GitHub webhooks will fail silently with HTTP 302 / 403.
:::

In your Access Application policies:
- **Add a Bypass Policy**:
  - Selector: **Path Begins With**
  - Paths:
    - `/api/slack/` (covers `/api/slack/events`, `/api/slack/interact`, and `/api/slack/command`)
    - `/api/github/webhook`
- These endpoints are protected by cryptographic HMAC signatures (`X-Slack-Signature` and `X-Hub-Signature-256`) evaluated fail-closed inside the Worker code.

In your environment or `.dev.vars`:
```sh
REQUIRE_ACCESS=true
```

---

## 5. GitHub Token & Scoped Permissions (PLAN.md §6, T6)

AI Coworker needs permission to clone target repositories, commit changes, and optionally open Pull Requests.

### Create a Scoped GitHub Token:
1. Go to **GitHub Settings** > **Developer Settings** > **Personal Access Tokens** > **Fine-grained tokens**.
2. Scope the token to the specific repositories you want AI Coworker to access.
3. Grant **Repository Permissions**:
   - **Contents**: `Read and write`
   - **Pull requests**: `Read and write`
4. Store the secret in Cloudflare:
   ```sh
   npx wrangler secret put GITHUB_TOKEN --config apps/backend/wrangler.jsonc
   ```

### Egress Isolation Invariant:
Even if a token has access to multiple repositories, the container egress proxy (`approveRepoScope("/owner/repo")`) strictly binds github.com requests to the exact target owner/repo of the approved task. Calls to any other repository return **HTTP 403 Forbidden**, preventing supply-chain exfiltration.

---

## 6. Slack Bot Integration (PLAN.md §9, Optional)

AI Coworker can be operated directly from incident and development channels via Slack mentions (`@shiba-ai-coworker fix this`).

### 1. Slack App Configuration:
1. Create an app at [api.slack.com/apps](https://api.slack.com/apps).
2. Under **OAuth & Permissions**, add Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `groups:history`
   - `im:history`
   - `reactions:write`
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`) and **Signing Secret**.

### 2. Configure Endpoints:
- **Event Subscriptions**: Enable events, set Request URL to:
  `https://<your-worker-domain>/api/slack/events`
  (Subscribes to `app_mention` and `message.im` — the latter lets teammates DM the coworker)
- **Interactivity & Shortcuts**: Enable interactivity, set Request URL to:
  `https://<your-worker-domain>/api/slack/interact`

### 3. Approver Allowlist Security:
:::note[Approver Allowlist Required]
A Block Kit button in a public Slack channel can be clicked by any channel member. AI Coworker enforces `SLACK_APPROVERS`. If this variable is empty, nobody in Slack can approve tasks (fails closed).
:::

Configure your secrets:
```sh
npx wrangler secret put SLACK_BOT_TOKEN --config apps/backend/wrangler.jsonc
npx wrangler secret put SLACK_SIGNING_SECRET --config apps/backend/wrangler.jsonc

# Comma-separated Slack User IDs permitted to click Approve:
npx wrangler secret put SLACK_APPROVERS --config apps/backend/wrangler.jsonc
# e.g., U01234567,U09876543
```

### 4. Telegram (Optional)

The same approval-gated flow runs on Telegram for free — no Slack workspace needed. Create a bot with @BotFather, store `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_APPROVERS`, then `setWebhook` to `/api/telegram/webhook`. Full steps: [Telegram Integration](/docs/telegram/).

---

## 7. First Acceptance Run (PLAN.md §7, T10)

Once configured, verify the deployment end-to-end with the **first acceptance run** (the "Aha Moment"):

1. Open the Dashboard at `https://<your-worker-domain>/app/`.
2. In the **New Coding Task** sidebar:
   - **Repository**: Enter your test repository URL (e.g. `https://github.com/my-org/test-repo`).
   - **Base branch**: `main`
   - **Coding agent harness**: Select `OpenCode` (or `Claude Code` / `Codex`).
   - **Task**: Describe a bounded coding task:
     ```text
     Add a health-check endpoint test in test/health.test.ts and verify vitest passes.
     ```
   - **Open a pull request**: Check if you want a live PR created.
3. Click **Submit Task** (or press `⌘ + Enter`).
4. **Inspect the Approval Card**:
   - Think plans the task and displays a pending approval card with the exact command, arguments, and scoped repository.
5. Click **Approve**:
   - The `shiba-ai-coworker-sandbox` container boots in Cloudflare.
   - Progress events stream live to the terminal output.
   - The agent inspects code, writes changes, and executes tests.
   - Upon completion, review the **unified diff** in the DiffViewer, and view the opened Pull Request link on GitHub!

---

## 8. Summary of Runtime Environment Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `GATEWAY_ID` | Var | `default` | Account-owned Cloudflare AI Gateway name |
| `CODING_MODEL` | Var | `google/gemini-3.5-flash-lite` | Default model for OpenCode harness |
| `CLAUDE_CODE_MODEL` | Var | `anthropic/claude-sonnet-4-6` | Model for Claude Code harness |
| `CODEX_MODEL` | Var | `openai/gpt-5.3-codex` | Model for Codex harness |
| `AGENT_HARNESS` | Var | `opencode` | Default coding engine (`opencode`, `claude-code`, `codex`) |
| `SLACK_AGENT_HARNESS` | Var | `AGENT_HARNESS`, then `claude-code` | Coding engine for Slack-originated runs |
| `REQUIRE_ACCESS` | Var | `false` | Enforces `cf-access-authenticated-user-email` header |
| `GITHUB_TOKEN` | Secret | Unset | Scoped GitHub PAT for PR publishing |
| `GITHUB_WEBHOOK_SECRET` | Secret | Unset | HMAC secret for GitHub webhooks |
| `SLACK_BOT_TOKEN` | Secret | Unset | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Secret | Unset | Slack App signing secret |
| `SLACK_APPROVERS` | Var/Secret | Unset | Comma-separated Slack User IDs permitted to approve |
| `SLACK_CHANNEL_REPOS` | Var | Unset | Default channel-to-repo mapping (e.g. `C123:owner/repo`) |
| `TYPESAFE_API_KEY` | Secret | Unset | Optional TypeSafe key for `run_when` automation gate |
| `AUTOMATION_DAILY_RUN_BUDGET` | Var | `20` | Maximum automated container runs per day |

