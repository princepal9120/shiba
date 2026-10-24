# t3code harness, and the Shiba session layer

Studied from [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at `d53873b6` (2026-10-24, `main`). This is the server/provider layer that drives Codex and Claude Code, not the Electron shell (`docs/desktop-plan.md` covers the shell). Shiba's implementation of the same ideas lives in `scripts/agent-harness.mjs` and is what the local daemon and the sandbox runner both call.

## Where t3code puts it

The desktop does not spawn agent CLIs. `apps/desktop` starts a local server; that server owns every provider process.

| Piece | Path | Role |
| --- | --- | --- |
| Codex wire protocol | `packages/effect-codex-app-server` | JSON-RPC over the `codex app-server` stdio pipe. Generated methods in `src/_generated/meta.gen.ts`. |
| Provider port | `packages/provider-core/src/server/ProviderAdapter.ts` | One interface every driver implements. Events are the only way a turn reports progress. |
| Codex driver | `apps/server/src/provider/Drivers/CodexDriver.ts` | Spawns `codex app-server` (`codexLaunchArgs.ts` → `["app-server", ...]`). One process can host many threads. |
| Claude driver | `apps/server/src/provider/Drivers/ClaudeDriver.ts` and `orchestration-v2/Adapters/ClaudeAdapterV2.ts` | Talks to Claude Code through `@anthropic-ai/claude-agent-sdk` (`query`). The raw source tag on stored events is `claude.sdk.message` / `claude.sdk.permission`. |
| Session manager | `apps/server/src/orchestration-v2/ProviderSessionManager.ts` | Opens, idles, and closes provider sessions. Many threads can be in flight; a keyed lock stops two turns from sharing one native thread. |
| Event log | `apps/server/src/persistence/OrchestrationEventStore.ts` | Append-only SQLite. Each domain event gets a sequence. Live clients tail the log; restart replays it. Projections are derived, not the source of truth. |
| Checkpoints | `apps/server/src/checkpointing/CheckpointStore.ts` | Git (or another VCS driver) captures a ref before and after a turn. The turn diff is commit-to-commit. Restoring files without rolling the conversation back is refused. |

Normalized provider events (`providerRuntime.ts`) keep the raw payload (`codex.app-server.notification`, `codex.app-server.request`, `claude.sdk.message`) beside a canonical item: assistant text, tool lifecycle, approval request, plan, diff.

## Codex app-server

The child is `codex app-server` with `--listen stdio://` unless launch args say otherwise. Frames are JSON-RPC 2.0, one JSON object per line.

Handshake, once per process (a second `initialize` is an error, code `-32600`, `"Already initialized"`):

1. Client request `initialize` with `clientInfo` and `capabilities` (`experimentalApi` is on in t3code).
2. Client notification `initialized` with no id.

Thread lifecycle:

- `thread/start` — `cwd`, `model`, `approvalPolicy` (`untrusted` | `on-request` | `never`, or a granular object), `sandbox` (`read-only` | `workspace-write` | `danger-full-access`), `approvalsReviewer` (`user` | `auto_review` | `guardian_subagent`). Response carries `thread.id`.
- `thread/resume` — same policy fields plus `threadId`.
- `thread/fork`, `thread/archive`, `thread/revert` exist; Shiba's adapter uses start, resume, and the turn methods.

Turn lifecycle:

- `turn/start` — `threadId`, `input` (a list of `{ type: "text", text }`), optional overrides for `approvalPolicy`, `sandboxPolicy` (`{ type: "readOnly" | "workspaceWrite" | "dangerFullAccess" }`), `model`, `cwd`. Response is `{ turn: { id } }`. The turn keeps running after that response.
- Notifications: `turn/started`, `item/agentMessage/delta` (`delta`, `itemId`, `threadId`, `turnId`), `item/started`, `item/completed`, `turn/diff/updated` (`diff`), `turn/plan/updated`, `turn/completed` (`turn.status`: `completed` | `interrupted` | `failed` | `inProgress`).
- `turn/interrupt` — `{ threadId, turnId }`. The turn ends as `interrupted`.
- `turn/steer` exists for mid-turn user input. Shiba does not send it.

Server requests (they have an id; the client must answer or the turn stalls):

- `item/commandExecution/requestApproval` — `itemId`, `threadId`, `turnId`, `command`, `reason`, optional `approvalId`.
- `item/fileChange/requestApproval` — `itemId`, `grantRoot`, `reason`.
- `item/permissions/requestApproval`, legacy `execCommandApproval`, `applyPatchApproval`.
- Response decision for command and file-change: `accept` | `acceptForSession` | `decline` | `cancel` (command also allows exec-policy amendments).

t3code's runtime-mode defaults (`CodexAdapterV2.codexRuntimeModeTurnDefaults`):

| Mode | approvalPolicy | sandbox | reviewer |
| --- | --- | --- | --- |
| `approval-required` | `untrusted` | `readOnly` | `user` |
| `auto-accept-edits` | `on-request` | `workspaceWrite` | `user` |
| `auto` | `on-request` | `workspaceWrite` | `auto_review` |
| `full-access` | `never` | `dangerFullAccess` | `user` |

Approvals are live only: a pending request does not survive a process restart (`pendingRequestsSurviveRestart: false`). One app-server process serves many threads (`supportsMultipleProviderThreadsPerSession: true`).

## Claude Code

t3code does not parse Claude's stdout itself. `ClaudeAdapterV2` calls the Agent SDK `query()`. The SDK spawns `claude` and speaks the bidirectional stream-json control protocol. Capabilities recorded on the adapter:

- One thread per process (`supportsMultipleProviderThreadsPerSession: false`). Interrupt and steering are supported; interrupt stops the in-flight tool.
- Permission modes follow the runtime policy: `plan` → `plan`, approval-required → `default`, auto-accept-edits → `acceptEdits`, full access → `bypassPermissions`. Read-only tool presets are `Read`, `Glob`, `Grep`.
- Session ids are strong. Turn ids are weak. Resume is `--resume <session_id>` plus the SDK's history fork.
- Tool approval is a `can_use_tool` control request with a `request_id`. The answer is `behavior: "allow"` (and the tool input) or `behavior: "deny"`.
- Checkpoints are the app's git refs, same store as Codex. Claude can roll the conversation back; the filesystem restore is paired with that.

Messages the CLI writes: `system`/`init` (carries `session_id`), `assistant` content blocks (text and `tool_use`), `stream_event` text deltas, `result` (`is_error`, `result`, `session_id`), and `control_request` / `control_response`.

## Orchestration model

A user message becomes a turn. The provider adapter emits events; `ProviderEventIngestor` turns them into domain events; `EventStore.appendAgentEvents` assigns the next sequence and publishes. The UI reads projections, and a reconnect replays from a sequence watermark.

Sessions are concurrent. The session manager keeps a map of open provider sessions and a busy-turn key per native thread so two turns cannot run on the same thread. Idle sessions close after a timeout. Shutdown interrupts active turns and waits for the process group.

Checkpoints: capture a hidden git ref at turn start and turn end (index is temporary, HEAD is not moved). `diffCheckpoints` is `git diff` between those refs. A restore that would move the worktree without moving the conversation is refused — Shiba already has this rule in `apps/backend/src/git-checkpoint.ts`.

Interrupt is `turn/interrupt` (Codex) or an SDK interrupt (Claude). Resume is `thread/resume` or `--resume`, then a new `turn/start` / user message on the same native thread.

## What Shiba implements

`scripts/agent-harness.mjs` is the provider-agnostic session layer. It has no npm dependencies. The desktop daemon imports it, and the sandbox runner writes the same file into the container and executes it with `node`.

- **Codex adapter.** Spawns `codex app-server --listen stdio://`, performs `initialize` / `initialized`, `thread/start` or `thread/resume`, `turn/start`, and `turn/interrupt`. It answers approval server-requests and refuses `account/chatgptAuthTokens/refresh` (refresh stays on the Worker, never in the child).
- **Claude adapter.** Spawns `claude` with `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`, sends the user message on stdin, answers `can_use_tool`, and interrupts with a `control_request` of subtype `interrupt`. `--resume` continues a session id.
- **Normalized events.** `session.updated`, `thread.updated`, `turn.started`, `message.delta`, `message.completed`, `tool.started`, `tool.completed`, `approval.requested`, `approval.resolved`, `diff.updated`, `checkpoint.captured`, `turn.completed`, `error`. Appended as JSONL (`seq`, `at`, `event`) so a session can be replayed. The log lives outside the git worktree (the run home locally, `/tmp/shiba-sessions` in the sandbox) so `git add -A` does not record it.
- **Permission modes.** `approval-required` waits for a decision. `accept-edits` and `bypass` answer allow without blocking (the sandbox's outer approval already ran). `plan` denies command and file-change tools.
- **Approvals.** On the local daemon, a request is posted to `/api/local/approval` and the dashboard decides it at `/api/computers/harness/decide`. The CLI stays blocked until then.
- **Checkpoints and diffs.** Hidden refs `refs/shiba/checkpoints/<id>/<seq>`, same commit-tree trick as the sandbox. The turn diff is emitted as `diff.updated` and returned on the job result, which the existing collect/PR path already publishes.
- **Interrupt and resume.** `turn/interrupt` or Claude's interrupt control request. Resume uses the native thread id from the event log.
- **Concurrent sessions.** `createSessionManager` holds an independent child process and log per session.

The cloud container uses this runner for `codex`, `claude-code`, `claude-subscription`, and `claude-login`. Permission mode there is `accept-edits`: nobody is inside the container to click, and the run was already approved. The local daemon uses `approval-required`, so tool calls stop on the Approvals page. `codex-subscription` keeps its existing plan driver (`codex-chatgpt-plan-driver.ts`): that script must contain the ChatGPT-plan `-c` flags and must not contain the access token. The new adapter is the same app-server protocol; it is not a second place the token is written down.

Stdout lines are `{"type":"shiba.event","event":…,"text":…}`. The Claude and Codex `parseEvent` paths turn those into the progress feed the run already stores.

## Unverified against real subscriptions

No test here logs into ChatGPT or Claude.ai. The fake CLIs speak the frames above; they are not `codex` or `claude`. Still unchecked on a real subscription:

- ChatGPT plan `ACCESS_TOKEN` through `codex app-server` with `model_provider=openai_chatgpt_plan` (the older plan driver is what production subscription runs still launch).
- `account/chatgptAuthTokens/refresh` — the adapter rejects it on purpose.
- Claude Agent SDK control-protocol revisions newer than stream-json `can_use_tool` / `interrupt` / `--resume`.
- `turn/steer`, thread fork, granular approval amendments, and subagent threads.
- A live pull request against github.com. The desktop journey opens a pull URL from a mocked GitHub response.
