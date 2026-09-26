---
title: Use from Claude Code
description: Connect Claude Code (or any MCP client) to the Worker's /mcp gateway with a scoped bearer token and queue approval-gated coding runs.
---

The Worker serves an MCP gateway at `https://<worker-host>/mcp` (streamable HTTP). Claude Code connects with a per-agent bearer token. It can queue coding runs, read run and approval state, and use the mailbox and memory tools its token's scopes allow. It cannot approve anything. A queued run waits until a human approves it in the dashboard or in Slack.

## 1. Mint a token

From the repo root:

```bash
node scripts/mint-token.mjs --agent claude-code --scopes sandbox:exec,runs:read --ttl-days 30 --host <worker-host>
```

| Flag | Meaning |
| --- | --- |
| `--agent <name>` | Principal recorded on every audit row. No whitespace, max 128 chars. |
| `--scopes <a,b>` | Comma list from: `email:read`, `email:draft`, `email:send`, `email:delete`, `memory:read`, `memory:write`, `runs:read`, `sandbox:exec`, `admin:tokens`. |
| `--ttl-days N` | Optional. The KV entry expires after N days, and the token stops working then. |
| `--host <host>` | Your Worker host, used in the printed `claude mcp add` line. |
| `--write` | Also runs the printed `wrangler kv key put … --remote` for you. Without it, nothing is written. |

The script prints the raw `shb_…` token once, the KV key (`tok_<sha256(token)>`), the record value, the `wrangler` command and the `claude mcp add` line. Only the hash is stored, so a lost token cannot be recovered. Mint a new one instead.

`--binding AGENT_TOKENS --config apps/backend/wrangler.jsonc` writes to the namespace id in `wrangler.jsonc`. If you deploy with Alchemy, first check that this id matches the `shiba-agent-tokens` namespace (`npx wrangler kv namespace list`). If it doesn't, run the command with `--namespace-id <id>` in place of `--binding AGENT_TOKENS`.

## 2. Add the server to Claude Code

```bash
claude mcp add --transport http shiba https://<worker-host>/mcp --header "Authorization: Bearer shb_…"
```

Run `claude mcp list` to confirm that `shiba` connects. A 401 means the token is missing, malformed, revoked, expired, or was written to a different namespace.

## 3. Tools and scopes

| Tool | Scope | What it does |
| --- | --- | --- |
| `queue_run` | `sandbox:exec` | Queues `{repoUrl, task, baseBranch?, publishPullRequest?}` as a pending approval on the shared `default` orchestrator, the same route as `POST /api/runs`. Returns `approvalId` and `runId` (`agent-tool:<approvalId>`). It never starts a run. |
| `run_status` | `runs:read` | Returns one run record by `runId`. |
| `list_runs` | `runs:read` | Lists run records, newest first (`limit`, default 20). |
| `list_approvals` | `runs:read` | Lists pending and recently decided run approvals. Email approvals are left out. |
| `list_mailboxes`, `list_emails`, `get_email`, `get_thread`, `search_emails`, `mark_email_read` | `email:read` | Mailbox reads. |
| `create_draft`, `update_draft`, `draft_reply`, `move_email` | `email:draft` | Draft and organize. |
| `send_email`, `send_reply` | `email:send` | Queue an email send for human approval. |
| `delete_email` | `email:delete` | Queue a delete for human approval. |
| `memory_recall`, `memory_sessions` | `memory:read` | Read shared memory. |
| `memory_bank`, `memory_forget` | `memory:write` | Write shared memory. |

The gateway has no approve tool. This MCP tool accepts only repository/task/branch/publish inputs, not a per-run harness or model; queued runs use the deployment's configured defaults (`AGENT_HARNESS`, `CODING_MODEL`, and the selected harness's model default) when approved. Harness implementation and verification status are documented in [Coding Harnesses](/docs/claude-code/). No cloud end-to-end run is recorded; the dated local OpenCode exercise did not reach successful model inference.

Run visibility is per-principal: `run_status`, `list_runs`, and `list_approvals` only return records the calling token's principal queued (`queuedBy` is stamped at intake). Operator surfaces — dashboard, Slack, `/api/runs` with an Access identity — still see everything. Pair `sandbox:exec` with `runs:read` on tokens that queue and poll runs.

## 4. How `/mcp` is authenticated

`/mcp` and `/mcp/*` are **bypassed in Cloudflare Access**, because an MCP client cannot complete an Access login. The Worker authenticates these requests itself with the bearer token:

- The Worker checks the token's shape, then looks up its SHA-256 hash in `AGENT_TOKENS`. A missing, unknown, revoked, or expired token gets a plain `401` before any MCP traffic is served, and so does a KV outage.
- The verified record reaches the gateway in a Worker-set header. Client copies of that header are stripped.
- Every tool call is checked against the token's scopes and writes a row to the audit log (`GET /api/audit`). The row holds the principal, the tool, a hash of the arguments and the outcome, never the arguments themselves.

See [Security](/docs/security/) for the Access bypass policy and [Approval Gates](/docs/approval-gates/) for how a human resolves a queued run.

## Revoke a token

Delete its KV entry:

```bash
npx wrangler kv key delete --binding AGENT_TOKENS tok_<sha256> --config apps/backend/wrangler.jsonc --remote
```

The next request with that token gets a `401`.
