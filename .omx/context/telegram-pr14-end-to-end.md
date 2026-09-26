# Telegram lane (PR #14) — end-to-end recovery

Repo: `github.com/princepal9120/shiba` (public, default branch `main`)
Working worktree for this team: `/Users/princepal/oss/shiba-telegram-fix`
Branch: `fix/telegram-lane-verify` (tracking `origin/feat/unified-dashboard-marketing-ui` = PR #17 head)

## Target

Make the Telegram approval-gated trigger lane work **end to end on `main`** — webhook auth,
pending approval, inline-keyboard decision, run start, and post-back — with the standing
security invariants intact, and land it as a reviewable PR that supersedes the closed PR #14.

## Why PR #14 was closed (evidence, not inference)

- PR #14 = `devin/1790188627-telegram-trigger` -> base `devin/1790102090-slack-coworker`.
  State CLOSED (2026-09-26T09:49:14Z), `mergeable: CONFLICTING`, 13 commits behind `main`.
- Close comment (owner): "Superseded by #17 ... This PR has a blocker: approvals call
  `getTelegramThreadStub(env, "telegram:{id}")` which throws — every Approve press fails."
- **The blocker is real.** In `pr14:apps/backend/src/telegram-routes.ts`:
  ```ts
  const resolveOrchestrator = deps.resolveOrchestrator ??
    ((threadKey: string) => getTelegramThreadStub(env, threadKey || ORCHESTRATOR_NAME));
  ```
  and `getTelegramThreadStub` (pr14 `telegram-thread.ts`) is
  `byName(env.CodingOrchestrator, buildTelegramThreadName(chatId))` — it **unconditionally
  re-prefixes** an already-prefixed key. `buildTelegramThreadName("telegram:123")` throws
  `Cannot name a Telegram conversation: chat_id "telegram:123" is malformed.`
  So the default production resolver throws on **every** Approve/Reject press. The PR's own
  tests only passed because they injected `deps.resolveOrchestrator` and never exercised the
  default path.
- A second, independent defect on PR #14: `pr14` never added `/api/telegram/webhook` to
  `ACCESS_BYPASS_PATHS` in `alchemy.run.ts` (`git diff 95cf12e pr14 -- alchemy.run.ts` is
  empty). With Cloudflare Access enabled the webhook is unreachable: Telegram gets a 302 to
  Access and retries. Slack got this right (`/api/slack/*` are in the list) — Telegram did not.

## Current state: the fix exists but is stranded

- `main` (999e944) has **zero** Telegram support — no `telegram*.ts`, no `chat-lane.ts`.
  The lane is not shipped and will not ship from #14.
- PR #17 (`feat/unified-dashboard-marketing-ui`, OPEN, 0 behind `main`, `MERGEABLE`)
  *does* contain the corrected lane: `apps/backend/src/chat-lane.ts`, `telegram.ts`,
  `discord.ts`, `test/chat-lane.test.ts`, `test/telegram.test.ts`, `test/discord.test.ts`,
  `env.ts` fields, `index.ts` dispatch, `orchestrator.ts` `postToThread`, and
  `ACCESS_BYPASS_PATHS += /api/telegram/webhook, /api/discord/interactions`.
- But #17 is a 148-file / +11394 / -3688 marketing + dashboard reskin. The Telegram lane is
  buried in an unrelated release-sized diff, so the actual blocker fix cannot merge on its own.
  Its own PR description does not even mention Telegram (it says Telegram/Discord are
  "future work" — stale vs. its own tree).
- PR #17 CI: last two runs on the branch `success`; a run was `in_progress` at snapshot time.

## The fix (verified in the #17 tree)

`chat-lane.ts` centralizes both chat platforms. Approvals resolve through
`decideChatApproval(env, {...}, resolve)` -> `resolve(threadKey)` ->
`getAgentByName(env.CodingOrchestrator, threadKey)` with the **already-built** key, wrapped in
try/catch. The double-prefix throw is gone. `queueChatRun` and `decideChatApproval` both treat
non-`approved`/`rejected` results and non-OK responses as failure — no fake success.

## Constraints (repo standing rules — CLAUDE.md)

- Approval gate is sacred: no sandbox starts before a human approves the exact input.
- Webhook/automation secrets are **header-only, never query parameters**.
- `GITHUB_TOKEN` never reaches the container, a clone URL, a log line, or a UI response.
- No fake success: report `error` with the real reason; never mark a run completed on unverified output.
- Prefer deletion and minimal diffs over new abstraction; use existing dependencies.
- Secrets are injected at AI Gateway egress; the container gets a dummy key.

## CI gate (must all pass before claiming done)

`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus
`node scripts/check-alchemy-drift.mjs` and `node scripts/check-env-types.mjs`.
`npx wrangler deploy --dry-run` needs a Docker daemon — record explicitly if unavailable.

## Work already done by the leader (do not redo)

- Cloned `shiba`, fetched `pr14`/`pr17` refs, created this worktree.
- Root-caused the `getTelegramThreadStub` throw and the missing Access bypass by reading diffs.
- Confirmed `chat-lane.ts` / `telegram.ts` / `discord.ts` import only
  `agents/routing`, `./env.js`, `./slack-context.js`, `./security.js`, `./slack-approval.js`,
  `./slack.js` — **no coupling to `model-connections.ts` / `model-policy.ts`**, which means the
  lane is portable onto `main` without the model-connections work.

## Unknowns to resolve in this team

1. Does the #17 lane pass the full CI gate on a clean install? (not just the branch's own last run)
2. Is the approval path genuinely fixed end to end, including the *default* resolver with no
   injected deps — the exact path PR #14 got wrong and its tests never covered?
3. What is the minimal, self-contained set of files/hunks to port the Telegram lane onto `main`
   without dragging in the marketing reskin or model-connections?
4. Any security regressions vs. the standing rules above (header-only secret, approver
   allowlist fails closed, token containment, replay/dedupe, callback_data <= 64 bytes,
   no `allowed_mentions`-style pings, card/task truncation honesty).
