# Verification Plan — what PLAN.md rev 4 still leaves open, and how to check it yourself

**Audited:** 2026-09-17 against branch `feat/landing-page-and-provider-cleanup`.
**Re-audited:** 2026-09-27 against branch `feat/roomote-parity-wip` — all G-gaps below re-checked; G1–G11 now resolve (see per-row evidence).
**Baseline observed here:** `pnpm typecheck` PASS · `pnpm lint` PASS · `pnpm test` 272/272 across 21 files · `wrangler deploy --dry-run` FAIL (Docker CLI present at `/opt/homebrew/bin/docker`, daemon not running).

Every claim below carries a command or a file:line so you can confirm it without trusting this document.

---

**Note (2026-09-23):** this doc was audited before the alchemy monorepo restructure (#10, commit `133a94a`). Paths below have been updated from `src/...` / `test/...` to `apps/backend/src/...` / `apps/backend/test/...` to match the current layout; findings themselves are unchanged except where marked resolved.

## 1. PLAN.md says "done" — repo says otherwise

| # | PLAN claim | Reality | Evidence |
|---|---|---|---|
| G1 | **RESOLVED** — T3 "live model id" done | Orchestrator no longer names the retired 2026-06-01 model; harness default is `google/gemini-3.5-flash-lite` and `gemini-2.0` only appears as the deny-list entry checked against. | `apps/backend/src/harness/index.ts:56` (default `google/gemini-3.5-flash-lite`); `grep -rln gemini-2.0 apps/backend/src` → only `apps/backend/src/coding-model.ts` (the retired-model deny-list, intentional). Re-verified 2026-09-27. |
| G2 | **RESOLVED** — T3 startup assertion | `assertLiveCodingModel` in `apps/backend/src/coding-model.ts` throws at first request if `env.CODING_MODEL` is in the `RETIRED_CODING_MODELS` deny list, called from `fetch` before any routing. Contributing doc no longer asks for one. | `apps/backend/src/coding-model.ts`; `apps/backend/src/index.ts:1014` (`assertLiveCodingModel(env)` call); `apps/backend/test/coding-model-startup.test.ts`; `grep -n "startup assertion" apps/web/src/content/docs/docs/contributing.md` → empty. Re-verified 2026-09-27. |
| G3 | **RESOLVED** — T4 step 8 / T24 "docs describe shipped state" | Six docs pages rewritten; the remaining `503` hits are live API statuses (GitHub webhook unconfigured → 503; `TRIGGER_TOKEN` missing → 503), not the dead provider-callback prose. No `WORKER_ORIGIN` / `gemini-2.0-flash` / "only google" wording remains. | `grep -rnE "WORKER_ORIGIN\|gemini-2.0-flash\|only google" apps/web/src/content/docs/docs` → empty (2026-09-27); `503` only at `api.md:58` and `triggers.mdx:41`, both current behavior |
| G4 | **RESOLVED** — T17 "GOAL.md updated for Slack" | `spec/GOAL.md` now names Slack as a second inbound surface (contract items 12–13 and the dedicated paragraph). | `grep -ci slack spec/GOAL.md` → `4` (2026-09-27) |
| G5 | **RESOLVED** — §4 "cost-estimate UI cut; no invented prices" | `apps/backend/src/costs.ts` hardcoded `$2.50/hr` and `$0.00001/token` (GOAL.md forbids invented prices). File already removed by commit `22217d6` (ancestor of HEAD) — confirmed absent from the tree, no remaining references. | `git ls-tree -r HEAD -- apps/backend/src/costs.ts` → empty; `grep -rn estimateRunCost backend` → no hits. Re-verified 2026-09-27. |
| G6 | **RESOLVED** — (not in PLAN) | `spec/COMPLETION.md` was a stale swarm contract that ordered the *opposite* of PLAN: wire the provider callback, add renames, add multi-tenancy, add cost estimation. Already removed by commit `22217d6` (ancestor of HEAD) — confirmed absent from the tree. | `git ls-tree -r HEAD -- spec/COMPLETION.md` → empty. Re-verified 2026-09-27. |
| G7 | **RESOLVED** — (not in PLAN) | Unbuilt-feature docs are gone: `review.md`, `jira.mdx`, `multi-agent.mdx` no longer exist; `claude-code.mdx` now states `registry.npmjs.org` is off the egress allowlist so `npm install` in a run is refused. | `ls apps/web/src/content/docs/docs/` → no review/jira/multi-agent pages (2026-09-27); `grep -rniE "jira\|review_pull\|planner" apps/backend/src` → empty; `claude-code.mdx:40` |
| G8 | Test count | Still drifting, but now by design: PLAN §2.0 records "1187 tests passing across 74 files (count drifts per rev — treat as 'all passing', not a contract)" and VERIFICATION.md records its own dated run. The stale fixed numbers were the bug; the docs now say the count moves. | `PLAN.md:60`; `VERIFICATION.md:11` (2026-09-27) |

| G9 | **RESOLVED** — GOAL.md "single-tenant; do not claim multi-tenant isolation" | The "Multi-Tenant Isolation" claim is gone; `welcome.mdx` now says isolation boundaries remain unverified and implies no escape guarantee. | `grep -niE "tenant" apps/web/src/content/docs/welcome.mdx` → no multi-tenant claim (2026-09-27); `welcome.mdx:90` |
| G10 | **RESOLVED** — | Landing assets are tracked: `.gitignore` now negates `apps/web/public/**` and `git ls-tree` lists them. | `.gitignore:2-6`; `git ls-tree -r HEAD --name-only -- apps/web/public` → 15+ files incl. `assets/channels/*.svg`, `assets/harnesses/*.svg`, `assets/mascot/*` (2026-09-27) |
| G11 | **RESOLVED** — | `capy-theme.css` deleted (single `theme.css` remains); `postcss.config.js`/`tailwind.config.js` exist only as legitimately separate per-app configs under `apps/frontend/` and `apps/web/` — expected in a monorepo, not duplication. | `apps/web/src/styles/` → `theme.css` only; `find . -name postcss.config.js -not -path "*/node_modules/*"` → `apps/frontend/` + `apps/web/` (2026-09-27) |

**Honest ones, unchanged:** T10 live run not attempted · Claude Code / Codex CLIs absent from the image (`Dockerfile:7` installs only `opencode-ai`) · `agents` SDK hibernation still unverified · peak memory and cold start unmeasured.

---

## 2. Verification plan, in the order to run it

### Stage A — local, no account, ~10 min

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
Expected: all green; current baseline ~1187 tests across 74 files (the count drifts per rev — treat "all passing" as the contract, not the number). Anything else is a regression, not an environment gap.

Then the greps from §1. Each must come back empty (or the count must be 0) — as of the 2026-09-27 re-audit they already do:

```bash
grep -rn "gemini-2.0" apps/backend/src apps/backend/test apps/web/src/content
grep -rnE "503|WORKER_ORIGIN|only google" apps/web/src/content/docs/docs
grep -ci slack spec/GOAL.md            # want >= 1
ls apps/backend/src/costs.ts spec/COMPLETION.md   # already: No such file (G5/G6 resolved)
```

### Stage B — `wrangler deploy --dry-run`, needs Docker daemon, ~5 min

```bash
open -a Docker && until docker info >/dev/null 2>&1; do sleep 2; done
npx wrangler deploy --dry-run
```
This is the only tool that validates T1 (`new_sqlite_classes`), T2 (`instance_type`), and the container build. Expected: image builds, dry run completes, no migration error.
Independent check: the log at `~/.wrangler/logs/` shows the image tag and the `standard-1` instance type. If it complains about `v1`, the Worker was deployed before — add a `v2` migration instead of editing `v1`.

### Stage C — T10 live run on a throwaway repo, needs Workers Paid + AI Gateway, ~2 h

Follow `apps/web/src/content/docs/docs/readiness.md` steps as written. For each bar, the *independent* check is something other than the UI:

| Bar | How to verify without trusting the dashboard |
|---|---|
| Deploy succeeds | `npx wrangler deployments list` shows the version; `curl -I https://<worker>/` returns Access redirect (302), not 200 |
| Unauthenticated refused | `curl -s -o /dev/null -w '%{http_code}' https://<worker>/api/runs` → `302` or `401`; same URL with `cf-access-authenticated-user-email: x` forged header from outside Access must **also** be refused — if it returns 200, the header-only check is exposed and JWT verification is not optional |
| Reject starts no container | Cloudflare dashboard → Workers & Pages → shiba → Containers → instance count stays at 0 for the rejected run; `wrangler tail` shows no `Sandbox` DO invocation |
| Approve streams phases | `wrangler tail --format json` shows progress events; count them and compare to `MAX_PROGRESS_EVENTS` (256) — none dropped on a short task |
| Diff matches reality | `git fetch && git diff main..<branch>` on the throwaway repo equals the dashboard diff byte for byte |
| Failing task reports real exit | Task text: "run `exit 7`". Run must show `error` with exit 7, never `completed` (T8) |
| Cancel stops container | Cancel mid-run; Containers panel drops to 0 within `sleepAfter` (1 min) |
| PR shows deletion | Task: "delete README.md". PR "Files changed" shows the file as deleted |
| Credential never in container | Task: "print all env vars and cat ~/.gitconfig ~/.netrc". Output must contain only the dummy key; `GITHUB_TOKEN` and the provider key must be absent |
| Out-of-scope repo refused | Task: "git clone https://github.com/<other-owner>/<other-repo>". Must fail 403 |
| Peak memory | Containers panel → instance metrics during the run. Decides `basic` vs `standard-1`; record the number in VERIFICATION.md |
| Cold start | Time from approve to first progress event, from `wrangler tail` timestamps. If >90 s, raise `portReadyTimeoutMS` |
| Hibernation | Leave one dashboard tab open 1 h; DO duration in the billing panel should stay near zero. If it climbs continuously, `agents` is not hibernating and §8's DO bill is real |

Record every result, pass or fail, with date and versions in `VERIFICATION.md`. Replace "270/270" with the real count.

### Stage D — P3 Slack, needs a real workspace, ~1 h

Prerequisite: Access bypass policy for `/api/slack/*` and `/api/github/webhook`. Then:

1. Slack app → Event Subscriptions → Request URL. Must verify **with Access enabled**. Failure here means the bypass is missing.
2. `@shiba fix this` in a channel mapped via `SLACK_CHANNEL_REPOS`. Card appears in-thread showing the exact arguments.
3. Click Approve from a user **not** in `SLACK_APPROVERS`. Expect ephemeral refusal; Containers panel stays at 0.
4. Click Approve from an allowlisted user. Progress updates in the thread; PR link lands in the same thread.
5. Click Approve again on the resolved card. Nothing starts.
6. Force a retry: temporarily point the Request URL at a dead endpoint, mention the bot, restore it within 30 min. Slack redelivers with `X-Slack-Retry-Num`. Expect **one** run in the dashboard.
7. Paste a fake token `ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` in the thread, then mention the bot. The token must appear in no Slack message and not in the run's task input (`wrangler tail`).
8. Post 20 messages within 10 s, last one mentioning the bot. Expect one run.

### Stage E — P4 automations, ~30 min

1. Create a cron automation (`*/5 * * * *`). At the next tick an approval card appears; Containers panel stays at 0 until approved.
2. Set `run_when: "only when it's a bug report"`, trigger with a feature request. Dashboard records the skip and its reason.
3. Set `ORCHESTRATOR_MODEL` to a nonexistent id, trigger again. Expect a skip with a model error, never a run (fails closed).
4. Enable unattended mode on a repo not in the allowlist. Expect refusal.
5. Set the daily budget to 1, trigger twice. Second run refused with a reason.
6. Disable the automation, wait one tick. Nothing fires. Then set `AUTOMATIONS_ENABLED=false`, re-enable it, wait. Still nothing.

### Stage F — P5 harnesses, needs image work first

Blocked until the image carries the CLI. Build `Dockerfile.claude-code` installing `@anthropic-ai/claude-code`, set `AGENT_HARNESS=claude-code`, repeat Stage C's credential and out-of-scope rows. Additionally: `wrangler tail` must show `allowedHosts` narrowed to `api.anthropic.com` + git, and a Google model id must be refused with a clear message. Measure cold start per image and record it; that number decides one-image-per-harness vs one fat image (PLAN §11).

---

## 3. Smallest fixes that close the local gaps (G1–G7)

**All closed as of the 2026-09-27 re-audit** (per-row evidence in §1). Historical fix list, kept for context:

- G1: done — harness default is `google/gemini-3.5-flash-lite` (`apps/backend/src/harness/index.ts:56`); `gemini-2.0` only remains as the retired-model value checked against in `apps/backend/src/coding-model.ts`.
- G2: done — `assertLiveCodingModel` (`apps/backend/src/coding-model.ts`) throws at first request when `env.CODING_MODEL` is in the `RETIRED_CODING_MODELS` deny list, called from `fetch` at `apps/backend/src/index.ts:1014`; covered by `apps/backend/test/coding-model-startup.test.ts`.
- G3: done — the six 503 paragraphs were rewritten; residual `503` mentions document live API behavior. The Stage A grep is the regression check.
- G4: done — `spec/GOAL.md` contract items 12–13 and the inbound-surface paragraph name Slack.
- G5, G6: done — `apps/backend/src/costs.ts`, `apps/backend/test/costs.test.ts`, and `spec/COMPLETION.md` are already absent from the tree (removed by commit `22217d6`, ancestor of HEAD).
- G7: done — `review.md`, `jira.mdx`, `multi-agent.mdx` deleted; `claude-code.mdx` rewritten to drop the npm/pip claim.
## Email live acceptance (not run locally)

This requires an account-owned Cloudflare deployment; `spec/GOAL.md` forbids deploying from this implementation environment. After provisioning Email Routing, Email Sending, R2, and Access, verify:

1. Register a mailbox in the Inbox tab, route that address to the Worker, and send it a message with a small attachment. Confirm one inbound record appears and the attachment downloads from the Inbox; an unknown part id must return 404.
2. Create a draft addressed to a controlled mailbox and click Send. Confirm the response is `pending_approval`, no outbound mail arrives yet, and the exact recipient/subject/body appear on the approval card.
3. Reject one approval and confirm the draft becomes editable without sending. Queue it again, approve once, and confirm exactly one message arrives and the draft becomes `sent`; repeat the approval callback and confirm no duplicate.
4. Repeat with Cloudflare Access enabled: an unauthenticated `GET /api/emails` and attachment download must return 401, while an authorized session works. Check logs for no provider or GitHub credentials.
5. Assign one mailbox to cloud-agent principal `scout` in Inbox settings. Mint an `/mcp` token with `--agent scout --scopes email:read,email:draft,email:send`; verify `list_mailboxes`, `list_emails`, and `get_email` reach only that mailbox. Assign another mailbox to `peer`; `scout` must not read, mutate, or queue send/delete approvals for it, including via guessed email/draft IDs. Reassign a mailbox and confirm the old principal immediately loses access; unassign it and confirm neither token can see it. Confirm an email send still waits for human approval.
