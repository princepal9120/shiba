# Verification Plan — what PLAN.md rev 4 still leaves open, and how to check it yourself

**Audited:** 2026-09-17 against branch `feat/landing-page-and-provider-cleanup`.
**Baseline observed here:** `pnpm typecheck` PASS · `pnpm lint` PASS · `pnpm test` 272/272 across 21 files · `wrangler deploy --dry-run` FAIL (Docker CLI present at `/opt/homebrew/bin/docker`, daemon not running).

Every claim below carries a command or a file:line so you can confirm it without trusting this document.

---

## 1. PLAN.md says "done" — repo says otherwise

| # | PLAN claim | Reality | Evidence |
|---|---|---|---|
| G1 | T3 "live model id" done | Orchestrator fallback still names the model shut down 2026-06-01. Fires whenever `CODING_MODEL` is unset (e.g. `wrangler dev` with a trimmed `.dev.vars`). VERIFICATION.md line 40 says this was removed; it was not. | `src/agents/orchestrator.ts:50`, `:131` |
| G2 | T3 startup assertion | None exists. Contributing doc still says "Add a startup assertion". | `grep -n assert src/index.ts` → empty; `apps/web/src/content/docs/docs/contributing.md:72` |
| G3 | T4 step 8 / T24 "docs describe shipped state" | Six docs pages still lead with "provider callback returns 503", `WORKER_ORIGIN remains required`, "only google/* accepted", default `gemini-2.0-flash`. README was fixed; the docs site was not. | `overview.md:48`, `api.md:40`, `troubleshooting.md:16`, `readiness.md:12`, `deployment.md:18`, `configuration.md:12,16` |
| G4 | T17 "GOAL.md updated for Slack" | `spec/GOAL.md` contains zero mentions of Slack. | `grep -ci slack spec/GOAL.md` → `0` |
| G5 | §4 "cost-estimate UI cut; no invented prices" | `src/costs.ts` hardcodes `$2.50/hr` and `$0.00001/token`. Dead code (only its test imports it) but it is exactly what GOAL.md forbids. | `src/costs.ts:7,10`; `grep -rn estimateRunCost src dashboard` → only the definition |
| G6 | — (not in PLAN) | `spec/COMPLETION.md` is a stale swarm contract that orders the *opposite* of PLAN: wire the provider callback, add renames, add multi-tenancy, add cost estimation. Next reader picks one of two contradictory specs. | `spec/COMPLETION.md:16-80` |
| G7 | — (not in PLAN) | Docs site documents features that do not exist in `src/`: a PR review agent (`review.md`), Jira integration (`jira.mdx`), a Planner/Executor/Reviewer hierarchy (`multi-agent.mdx`), and Claude Code "installing npm/pip packages" (`claude-code.mdx`; `registry.npmjs.org` is deliberately blocked). PLAN §4 cuts review and Linear-class integrations. | `grep -rniE "jira|review_pull|planner" src` → empty |
| G8 | Test count | PLAN says 269, VERIFICATION.md says 270, actual is 272. Cosmetic, but it means neither document was regenerated from a run. | `pnpm test` |

| G9 | GOAL.md "single-tenant; do not claim multi-tenant isolation" | Landing docs claim "Multi-Tenant Isolation". | `apps/web/src/content/docs/welcome.mdx:51-52` |
| G10 | — | All 7 landing-page images live under `apps/web/public/assets/**`, which `.gitignore:3` ignores. Fresh clone renders broken images; `test/marketing.test.ts` passes only on this machine. | `git ls-tree -r HEAD -- apps/web/public` → empty |
| G11 | — | Duplicated files: `theme.css` ≡ `capy-theme.css` (same blob); root and `web/` copies of `postcss.config.js` and `tailwind.config.js`. | `git diff --no-index apps/web/src/styles/theme.css apps/web/src/styles/capy-theme.css` |

**Honest ones, unchanged:** T10 live run not attempted · Claude Code / Codex CLIs absent from the image (`Dockerfile:7` installs only `opencode-ai`) · `agents` SDK hibernation still unverified · peak memory and cold start unmeasured.

---

## 2. Verification plan, in the order to run it

### Stage A — local, no account, ~10 min

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
Expected: all green, 272 tests. Anything else is a regression, not an environment gap.

Then the greps from §1. Each must come back empty (or the count must be 0) once G1–G7 are fixed:

```bash
grep -rn "gemini-2.0" src test apps/web/src/content
grep -rnE "503|WORKER_ORIGIN|only google" apps/web/src/content/docs/docs
grep -ci slack spec/GOAL.md            # want >= 1
ls src/costs.ts spec/COMPLETION.md     # want: No such file
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
| Reject starts no container | Cloudflare dashboard → Workers & Pages → shiba-ai-coworker → Containers → instance count stays at 0 for the rejected run; `wrangler tail` shows no `Sandbox` DO invocation |
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
2. `@shiba-ai-coworker fix this` in a channel mapped via `SLACK_CHANNEL_REPOS`. Card appears in-thread showing the exact arguments.
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

- G1: `DEFAULT_CODING_MODEL = "google/gemini-3.5-flash-lite"` and add one test asserting no source or test string contains `gemini-2.0`.
- G2: in `src/index.ts` `fetch`, throw at first request if `env.CODING_MODEL` is not in a small `RETIRED_MODELS` deny list. One line, one test.
- G3: rewrite the six 503 paragraphs to "provider traffic is intercepted at Sandbox egress; no callback exists". Add the grep from Stage A to `scripts/check-docs.mjs` so it cannot regress.
- G4: one paragraph in `spec/GOAL.md` naming Slack as a second inbound surface.
- G5, G6: `git rm src/costs.ts test/costs.test.ts spec/COMPLETION.md`.
- G7: either delete `review.md`, `jira.mdx`, `multi-agent.mdx` or move them under a clearly labelled "Not built" section. Rewrite `claude-code.mdx` to drop the npm/pip claim. Docs describing unbuilt features are the failure PLAN §12 T24 exists to prevent.
