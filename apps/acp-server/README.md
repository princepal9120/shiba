# @shiba/acp-server — `shiba-acp`

Shiba as an installable **ACP (Agent Client Protocol)** agent: point Zed,
JetBrains, or T3 Code at `shiba-acp` and your editor drives the deployment's
approval-gated runs — the same gate the dashboard, Slack, and email lanes
answer.

## How it maps

| ACP (editor → agent) | Shiba side |
|---|---|
| `initialize` | handshake — advertises text prompts, no fs/terminal (runs are remote) |
| `session/new {cwd}` | resolves the `origin` remote of `cwd` → run's `repoUrl` |
| `session/prompt` | `POST /api/runs` → `session/request_permission` (the human gate, in-editor) → `POST /api/approvals` → polls `/api/spine?since=` + `/api/runs` until the run settles → `{stopReason: "end_turn"}` |
| `session/cancel` | `DELETE /api/runs/<runId>` |
| `session/set_model` | carried into the run's `codingModel` |
| agent → editor | `run.progress` → `agent_message_chunk`; `side_effect.*` → `tool_call_update`; run summary/PR → final chunks |

Nothing runs until the editor answers the permission card — reject resolves
the approval `rejected` server-side and the prompt returns `refusal`.

## Setup

```bash
pnpm build          # produces dist/index.js (bin: shiba-acp)

export SHIBA_URL=https://app.tryshiba.dev
export SHIBA_TOKEN=<session-token>   # mint: shiba-acp login <email> <password>
```

### Zed — `settings.json` → `agent_servers`

```json
{
  "agent_servers": {
    "Shiba": {
      "command": "/path/to/shiba/apps/acp-server/dist/index.js",
      "env": {
        "SHIBA_URL": "https://app.tryshiba.dev",
        "SHIBA_TOKEN": "..."
      }
    }
  }
}
```

### JetBrains (AI Assistant / Junie ACP)

Add a custom ACP agent → command `node /path/to/dist/index.js` (or the bin),
env `SHIBA_URL` + `SHIBA_TOKEN`.

### T3 Code

Register `shiba-acp` as an external ACP server with the same env pair.

## Notes

- `SHIBA_TOKEN` is a better-auth session token (the deployment's operator
  credential). The server sends it as the session cookie — approval
  decisions therefore carry the operator principal, and agent-scoped
  principals can never decide.
- Text-only prompts; `loadSession` is off (runs resume by `runId`, not by
  transcript replay).
- The process is a thin protocol bridge: no local tools, no fs access —
  the sandbox on the deployment does the work.
