---
title: Dashboard
description: Compose, approve, observe, and interpret the current interface.
---

Sign in at `/app/` — the first account created becomes the only account (sign-up closes after it). A first-run wizard then walks through channels, connecting an agent provider, and model routing; every step is skippable and it never re-opens once finished.

The sidebar groups surfaces for normal use: **Workspace** (Dashboard, Tasks, Activity, Analytics, Diff, Approvals, Automations), **Capabilities** (Agents & MCP, Providers, Skills, Integrations, Mailbox, Memory), and **System** (Settings). **Activity** streams the orchestrator's event spine (`GET /api/spine` — decide→append→apply events plus the side-effect outbox); **Analytics** is the run-record and usage surface (`/api/usage` aggregates). Light/dark theme follows the in-app toggle on every surface.

Enter an HTTPS GitHub URL, base branch, and bounded task. Start without publishing. The planning agent proposes `delegate_coding_task`; read the **exact tool input** on the approval card, then approve or reject. The same gate applies to queued runs from **Approvals** (`POST /api/runs`). Approval is a workflow gate, not installation authentication.

## Phase 1 thread panels (Tasks view)

After the first message in a session, the timeline footer shows run outcome panels for the latest retained run on that thread:

| Panel | Meaning |
| --- | --- |
| **Run progress** | Registry status (`pending`, `running`, `completed`, error family). Includes a direct **Open pull request** link when `pullUrl` is on the run row. |
| **Pull request** | Live GitHub status from `GET /api/v1/threads/:id/pr/status`, with a waiting state while publish is in flight and a fallback link from `pullUrl` when GitHub status is not ready. |
| **Review findings** | Review round from `GET /api/v1/threads/:id/pr/review` when **Read-only review after publish** was frozen at approval. Failed rounds expose **Retry review** (`POST …/pr/review/retry`), which re-runs the reviewer unless the only failure was posting an already finished review. |

The composer shows **Sending task…** while a submit is in flight and **Planner responding** while the orchestrator is still streaming — the Send button stays disabled in both cases.

## Progress and results

The SDK supplies connection state. Vite-only development has no Worker backend, so connection errors are expected there.

Clone/configure/code/collect phases stream, but the runtime awaits the OpenCode process before returning its output. Token-level OpenCode streaming is not implemented. Inspect the final transcript for changes, bounded diff, errors, and any PR URL. The retained run API also stores `pullUrl`, `reviewAfterPublish`, and review round metadata for the panels above.

The parent currently treats string child output as completed, including possible error text. **Read the transcript, not just a completed badge.** An empty diff is not evidence of successful edits.

## Missions, Gates, VM, Runs

These surfaces were deleted, not just hidden — recurring goals live in **Automations**, sandbox state is summarized on the **Dashboard**, run records live on **Analytics**, and approvals land in the **Approvals** queue. There are no `?tab=` deep links for them; the code is gone.

## Providers and Integrations

**Providers** lists ACP agent adapters (Claude Code via `claude-agent-acp`, Codex via `codex-acp`, Gemini CLI, OpenCode, and the Grok CLI). Each card connects with subscription sign-in (Claude and ChatGPT, reusing the deployment's subscription probe) or an API-credential fallback, then shows status, test, disconnect, and the org default. The page reads `GET /api/providers`. The first-run wizard reads that same registry and links here; it does not call `/api/auth/*-subscription`. Grok's pinned CLI is not an ACP server; its card says so. **Agents & MCP** holds only the MCP gateway: the `/mcp` endpoint, client configuration snippets, token minting, and registered agent principals. **Skills** is the saved-skill manager — name, optional GitHub repo, notes; picked skills ship in a run's preamble so the executing agent receives them. **Integrations** lists third-party apps (GitHub, and coming-soon rows for Notion/Linear/Jira/Asana), chat & approval channels (Slack, Telegram, Discord), and email — not AI providers.

The composer also offers saved repositories (autocomplete seeded from run history) and per-purpose model routing — connections and purpose pins come from `/api/model-config` (`{connections, policy, purposes}`), where `connectionId` picks the credential route and the harness/model pair rides the approved run's frozen route.

### Reasoning effort

The **Effort** chip next to the model picker sets how hard the model thinks on this run. It lists only the levels the selected harness can pass to its CLI:

| Harness | Levels | Passed as |
| --- | --- | --- |
| Claude Code (API key, subscription, login) | low, medium, high, xhigh, max | `claude --effort` |
| Codex (API key) | minimal, low, medium, high, xhigh | `codex -c model_reasoning_effort=…` |
| OpenCode | low, medium, high | `opencode run --variant` |

Other harnesses take no effort. A run that asks for a level its harness can't honor is refused before an approval card exists. The effort is part of the frozen route, so the approval card shows it (`codex · openai/gpt-5 · effort high · via …`), the approval hash covers it, and steering, forks and API retries keep it.

### Repo setup

To have a run prepare the repository before the agent starts, commit a `.shiba/setup.json` and tick **Run repo setup** in the composer's thread configuration menu:

```json
{
  "format_version": 1,
  "scripts": { "initialize": "pnpm install --frozen-lockfile && pnpm build" },
  "timeouts": { "initialize": 900 }
}
```

- **Opt-in:** the setup script runs only when that box is ticked for the run. The tick is part of what you approve, and the approval card says `Setup: runs .shiba/setup.json initialize`. Steering, forks, API retries and CI follow-ups keep it.
- **Who can opt in:** only the box in the composer, or the authenticated `/api/runs` API. The chat agent's own tool call can't turn setup on.
- **Execution:** the script runs with `sh -c` in the cloned repository and gets the run's environment variables. It's the only repo-authored shell the runtime itself executes; every other command still has to match the exec allowlist. Exec receipts record the step as `.shiba/setup.json#initialize`, not the script text.
- **Timeout:** `timeouts.initialize` defaults to 600 seconds, with a maximum of 900 to keep the run within its deadline. Unknown keys in the file are refused. `scripts.refresh`, `timeouts.refresh` and `entries` are accepted but not run yet.
- **Baseline:** once the script succeeds, its effects are set aside in a local-only git commit (hooks off, never pushed). Installs, rewritten lockfiles and generated files never appear in the change or the pull request.
- **Overlap:** if the agent then changes a file the setup script also changed, the run fails rather than publish setup's edits as the agent's. Keep the script from editing tracked files.
- **Failure:** a missing or invalid file, or a non-zero exit, fails the run before the agent starts. The error shows the script's output tail, redacted like everything else.
- **Not supported:** runs on the local runtime don't take repo setup yet. Subagents and Captain crew runs don't run setup. A background process the script leaves running can still write into the repository.

### Environment variables

**+ → Environment variables** attaches name/value pairs to one run, for things like a test database URL. The values never sit in plain text anywhere shiba stores or returns them:

**Sealing and approval**
- The dashboard sends the values once to `POST /api/runs/env-seal`. That endpoint encrypts them under `MODEL_CREDENTIAL_KEY` and binds the result to your orchestrator and to a keyed digest of the exact values. The digest is an HMAC, so a stored record can't be used to check a guessed value.
- Approval cards and the run API show only the names. The approval hash covers the names and the digest.
- API responses and the event log never include the encrypted blob.

**During the run**
- The run's agent decrypts the values inside the Worker right before the sandbox starts.
- It passes them to the harness process and to the test command. Harness variables win on any shared name.
- Any value of 8 or more characters is replaced with `[redacted:NAME]` in everything the run sends back: progress, summary, stderr, the test-output tail, and the pull request body. This also catches the JSON-escaped form that appears inside agent event lines. The redaction runs before output is truncated, so a cut can't leave part of a value behind.
- If the change adds a value (on an added diff line, or inside a changed binary file), the run fails and the change is dropped, never returned or published. A value the repository already contained, such as a local development URL in an untouched config line, doesn't count.

**After the run**
- Once you decide the approval, the run holds the only copy of the encrypted blob. When the run finishes, that copy is discarded.
- Forking a finished run that had environment variables, or retrying it through the API, is refused. Start a new run and enter the variables again.
- A follow-up that a CI or review event opens is a new approval with no environment variables.

**Refused names:** names that steer the harness, egress, TLS trust, the dynamic loader or a toolchain's registry are refused. That covers `PATH`, `HOME`, `TMPDIR`, `*_PROXY`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `BASH_ENV`, `LD_*`, `PYTHON*`, `NPM_CONFIG_*`, `PIP_*`, `XDG_*`, `GIT_*`, `GITHUB_*` and `SHIBA_*`, plus provider-key prefixes such as `OPENAI_*` and `ANTHROPIC_*`. Ordinary app variables such as `NODE_ENV` or `DATABASE_URL` are fine.

**Limits:** 32 variables, 128-character names, 8 KiB per value and 32 KiB in total.

**Not supported:** runs on the local runtime don't take environment variables yet (this includes deployments whose default `RUNTIME` is `local`). A deployment without `MODEL_CREDENTIAL_KEY` refuses them.

**Known limits:**
- The chat transcript keeps the encrypted blob the composer sent. Rotating `MODEL_CREDENTIAL_KEY` makes every old blob undecryptable.
- Values shorter than 8 characters aren't redacted from output.

## Cancel and clear

Cancellation updates the registry before best-effort sandbox destruction. A successful request does not prove the process stopped. Verify shutdown for sensitive work.

Clear history asks for confirmation and clears chat plus retained registry records. It does not erase all child Durable Object data or stop active containers. Cancel and verify active work before clearing. If only part of the clear succeeds, the UI reports partial success; refresh to recheck retained state.

Review every generated diff and truncation marker. Run the target repository's tests before adoption. See [GitHub](/docs/github/) for publication fidelity limits.
