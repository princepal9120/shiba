---
title: Dashboard
description: Compose, approve, observe, and interpret the current interface.
---

Sign in at `/app/` — the first account created becomes the only account (sign-up closes after it). A first-run wizard then walks through channels, connecting an agent provider, and model routing; every step is skippable and it never re-opens once finished.

The sidebar groups surfaces for normal use: **Workspace** (Dashboard, Tasks, Runs, Diff, Approvals, Automations), **Capabilities** (Agents & MCP, Providers, Integrations, Mailbox, Memory), and **System** (Settings). Operator surfaces — Missions, Gates, VM inspector, Analytics — are not in the navigation; they remain reachable by `?tab=<name>` deep links for operators who need them. Light/dark theme follows the in-app toggle on every surface.

Enter an HTTPS GitHub URL, base branch, and bounded task. Start without publishing. The planning agent proposes delegate_coding_task; review the **exact tool input**, then approve or reject it. Approval is a workflow gate, not installation authentication.

## Progress and results

The SDK supplies connection state. Vite-only development has no Worker backend, so connection errors are expected there.

Clone/configure/code/collect phases stream, but the runtime awaits the OpenCode process before returning its output. Token-level OpenCode streaming is not implemented. Inspect the final transcript for changes, bounded diff, errors, and any PR URL. These are not independent fields in the retained run API.

The parent currently treats string child output as completed, including possible error text. **Read the transcript, not just a completed badge.** An empty diff is not evidence of successful edits.

## Missions, Gates, VM, Analytics

These operator surfaces were removed from the navigation to dedupe the sidebar — recurring goals live in **Automations**, sandbox state is summarized on the **Dashboard**, and approvals land in the **Approvals** queue. The views themselves still exist for operators via `?tab=missions`, `?tab=gates`, `?tab=vm`, and `?tab=analytics` deep links, covered by the same component/API tests. Their presence does not demonstrate cloud-live execution.

## Providers and Integrations

**Providers** is where you connect AI coding agents (Claude, Codex, Antigravity, Cursor, Devin) — each card runs the subscription-auth Connect flow backed by `/api/auth/<provider>-subscription` when the deployment enables it, and shows an honest status otherwise. **Agents & MCP** holds only the MCP gateway: the `/mcp` endpoint, client configuration snippets, token minting, and registered agent principals. **Integrations** lists third-party apps (GitHub, and coming-soon rows for Notion/Linear/Jira/Asana), chat & approval channels (Slack, Telegram, Discord), and email — not AI providers.

## Cancel and clear

Cancellation updates the registry before best-effort sandbox destruction. A successful request does not prove the process stopped. Verify shutdown for sensitive work.

Clear history asks for confirmation and clears chat plus retained registry records. It does not erase all child Durable Object data or stop active containers. Cancel and verify active work before clearing. If only part of the clear succeeds, the UI reports partial success; refresh to recheck retained state.

Review every generated diff and truncation marker. Run the target repository's tests before adoption. See [GitHub](/docs/github/) for publication fidelity limits.
