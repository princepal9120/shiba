# Verification Results

**2026-09-26 — cloud-agent mailbox pairing.** Inbox pairing now writes an `agent` principal; the MCP email tool registry limits all 13 tools to that principal's currently assigned mailboxes (including bare-ID lookup paths). New real-Mailbox-DO tests cover cross-agent denial, unassigned mailboxes, approval-mint refusal, and reassignment; the active AGPL `LICENSE` is unchanged. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` and `npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc` passed. This is local evidence only; a live cloud-agent `/mcp` round trip and real mail delivery remain unverified.

**Last run: 2026-09-26 (email API and attachment pass).**

## Status: Local checks and Wrangler dry-run PASS; cloud deployment and live mail unverified

| Check | Result |
|-------|--------|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS (0 errors) |
| `pnpm test` | PASS (1174 passed, 6 skipped across 74 files) |
| `pnpm build` | PASS (docs: 47 pages, 2286 links/assets/anchors verified; TanStack Start prerenders `/app`) |
| Frontend dev smoke | PASS — `/app/`, `/app`, manifest, and both app icons return 200 with expected content types |
| `npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc` | PASS — OrbStack built the configured image; no deployment performed |
| Alchemy deploy (`pnpm run deploy`) | PENDING — needs user `npx alchemy profile edit --add Cloudflare --method oauth` + `.env` (`pnpm run bootstrap`) |
| `npx alchemy plan` | Validates `alchemy.run.ts` loads and resolves stage `live_princepal`; stops only at `Provider 'Cloudflare' is not configured in profile 'default'` — expected until OAuth |

## 2026-09-24 — reliability review→fix pipeline + Alchemy deploy path

Four review agents audited the codebase; findings fixed and re-verified:

- **C1 — DO email store crashed in production.** `MailboxStore.addEmail` ran `BEGIN IMMEDIATE` via `ctx.storage.sql.exec`, which real DO SQLite forbids (tests passed because the node:sqlite fake allowed it). `transactionSync` is now injected (`src/mailbox-store.ts`, `src/mailbox-do.ts`); the shared fake `test/fixtures/do-sql-storage.ts` throws on BEGIN/COMMIT so the regression cannot come back.
- **C2 — no mailbox registration path.** Added `POST /api/mailboxes` on the directory DO + dashboard "+ Mailbox" form.
- **Access JWT verification** (`src/access-jwt.ts`): `Cf-Access-Jwt-Assertion` verified against team-domain JWKS (RS256 + aud), email identity rebuilt only from the verified token — forged `CF-Access-Authenticated-User-Email` headers get 401 (verified live against the deployed Worker).
- **Slack hardening**: slash ack within 3s + `response_url` follow-up via `waitUntil`; `ok:false` on HTTP 200 treated as failure; mrkdwn escaping on all user-controlled card fields; 3000-char section limit respected; approve click replaces the card.
- **Orchestrator**: `keepAliveWhile` around dispatch, `schedule(deadline+60, "reclaimRuns")`, outcome-unknown post to the Slack thread, `pullUrl` post-back, teardown via `ctx.waitUntil`.
- **Email handler**: R2 put failure deletes uploaded parts and throws; approval card carries 500-char body excerpt.
- **MCP run tools** (`src/mcp-run-tools.ts`): `queue_run`, `run_status`, `list_runs`, `list_approvals` — all `sandbox:exec`-scoped, picked fields only, **no approve tool** (human gate stays human).
- **`scripts/mint-token.mjs`**: mints `shb_` tokens as the same KV record `verifyToken` reads; `--namespace-id` for the Alchemy-owned KV; `--write` runs `wrangler kv key put`.
- **Alchemy one-step deploy** (`alchemy.run.ts`): Worker, `shiba-agent-tokens` KV, Vectorize metadata index, hostname-scoped Access apps (dashboard allow-list + machine bypass paths — worker-level Access would 403 WebSockets). `.env` is the secrets source of truth (`process.loadEnvFile`); `pnpm run bootstrap` collects everything and deploys.
- **Frontend**: TanStack Start SPA; mobile nav sheet, 44px targets, safe-area, PWA manifest/icons, Access-expiry redirect handling, seq-guarded polls, visibilitychange reconnect. Fresh verification: typecheck, lint, build and all 987 tests pass; dev URLs and PWA assets smoke-tested above.
- **Live Worker locked**: `REQUIRE_ACCESS=1` secret set; 401s verified including forged identity header.
- **Asset leak closed**: `apps/web/public/.assetsignore` (`**/.omc/`, `**/.DS_Store`) — Vite copies `apps/web/public` wholesale into deployable assets and `.omc` session state was shipping. Verified absent from `public/` after rebuild.

---

## Previous run: 2026-09-19 (rev 6, local end-to-end run)

## Status then: PASS, every check green including the dry run

| Check | Result |
|-------|--------|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | PASS (407/407 across 32 files) |
| `pnpm build` | PASS (docs: 25 pages, 1101 links verified, 21 markdown files stale-claim scanned) |
| `pnpm docs:check` | PASS |
| `npx wrangler deploy --dry-run` | **PASS (2026-09-19)** — image `cloudflare/sandbox:0.12.9-opencode` + `opencode-ai@1.18.31`, `claude-code@2.1.277`, `codex@0.155.0` built; four DOs bound; migrations v1/v2 accepted; `standard-1` accepted. |
| Live cloud run (PLAN.md T10) | **NOT ATTEMPTED** — `spec/GOAL.md` forbids deploying from this environment. See below for the local `wrangler dev` end-to-end. |

## Local end-to-end run — 2026-09-19 (`wrangler dev`, OrbStack Docker)

`wrangler dev --port 8788` with `.dev.vars` (`SLACK_SIGNING_SECRET`, `SLACK_APPROVERS=U_E2E`, both test-only). Real chain exercised over HTTP:

1. `POST /api/runs` `{repoUrl: octocat/Hello-World, task, baseBranch: master}` → `200`, `approvalId` issued, pending approval persisted on the `default` orchestrator DO.
2. `POST /api/slack/interact` with a locally HMAC-signed `block_actions` payload (`v0` signature, action `approve`, value `{threadKey:"default", approvalId}`) → `200` ack; allowlist admitted `U_E2E`; the DO resolved the pointer exactly once. **Note: interact resolves the orchestrator DO by `threadKey` — the DO name must match the queue target (`default`), not an arbitrary thread key.**
3. Approval → `delegate_coding_task` → `OpenCodeAgent` child → real Docker container `workerd-shiba-ai-coworker-Sandbox-*-proxy` up under OrbStack.
4. HTTPS egress interception ran: `approveRepoScope` installed `githubScoped` for `/octocat/Hello-World`; `git clone` succeeded into `/workspace/run-*`.
5. `opencode run --format json --model google/gemini-3.5-flash-lite` executed; provider egress was rewritten to AI Gateway `…/default/google-ai-studio` and returned **401 (code 2009, Unauthorized)** — no `AI_GATEWAY_TOKEN` in `.dev.vars` and no BYOK key visible. The error propagated as a structured envelope; run marked `error`; sandbox destroyed.

**Verified live locally:** queue → signed approval → DO dispatch → container spawn → scoped GitHub egress → clone → harness launch → provider egress rewrite → structured error → cleanup.
**Not verified:** model inference itself (needs `AI_GATEWAY_TOKEN` or a BYOK key in the `default` AI Gateway — the wrangler OAuth token lacks gateway read/write scope, so this is an account-config step, not a code gap).

## Limitations, stated plainly

**The dry run no longer blocks anything.** The prior "no Docker CLI / no daemon" limitation is retired: OrbStack was running this pass and the full dry run completed. T1–T3 (SQLite migration, instance type, model id) are validated.

**No live end-to-end *cloud* run has been performed.** `spec/GOAL.md` forbids deploying from this environment. The local `wrangler dev` run above now covers the whole path except the model call — but it is still not a cloud deploy, so status remains **local prototype** until a dated live run against the PLAN.md §15 P2 bar is recorded here.

Specifically unmeasured: peak container memory (which decides `basic` vs `standard-1`, and per PLAN.md §8 is the binding cost constraint), cold-start time, and whether the `agents` SDK uses the WebSocket Hibernation API.

**The Claude Code and Codex CLIs ship in the image but have not run live.** The Dockerfile installs `opencode-ai@1.18.31`, `@anthropic-ai/claude-code@2.1.277`, and `@openai/codex@0.155.0`, and the image build verifies each binary reports its version. Their config, argv, env, and event parsers are unit-tested against their documented stream formats; neither has been run against the live API, so a stream-format drift would surface at the first real run, not before. The dashboard's harness picker is wired end to end; only OpenCode has completed a live run.

## What the 407 tests do cover

- **Egress credential boundary.** `github.com` defaults to refusal; the credential is attached only for the run's own `/owner/repo`, with prefix-confusion siblings (`/owner/repo-evil`) and non-GitHub destinations refused, and no `Authorization` header reaching a refused request. The scope is proven to be installed *before* the clone, not after.
- **Automation safety.** Approval required by default; unattended mode refused for a non-allowlisted repo and for any run mutating more than a pull request; the daily budget refusing run N+1 with its reason and resetting on the next UTC day; both kill switches.
- **The `run_when` gate failing closed** on a model error, an empty answer, an unparseable answer, TypeSafe HTTP/parse errors, and noul below 0.8.
- **Harness isolation.** Each harness's `allowedHosts` contains only its own provider host plus git, never another harness's; every harness passes the container the dummy key and nothing matching a real credential shape; OpenCode's argv, config path, config contents, and env are pinned byte for byte against the pre-T22 behavior.
- Run result envelope parsing (an `error` envelope never reads `completed`), Slack signature verification and replay bounds, approver allowlisting, burst grouping, cron parsing and coalescing, GitHub tree publishing including deletions.

## Fix history

**2026-09-26 (rev 8 — PR #17 unified chat lanes + ce-code-review pass, 1178 tests)**
- **Telegram + Discord lanes.** Shared `chat-lane.ts` plumbing; orchestrator conversation per chat/channel (`telegram:{chatId}`, `discord:{channelId}`). Telegram: header-secret auth, `update_id` ring + durable dedupe, inline-keyboard approvals gated on `TELEGRAM_APPROVERS`. Discord: Ed25519 signature + 300s replay window verified before parsing, `/shiba` slash command with deferred reply, button approvals gated on `DISCORD_APPROVERS`. Approval payloads are pointers (`approve:{uuid}`) re-checked server-side.
- **Frozen route end to end.** `resolveCodingRoute` mints the `ApprovedRoute` at queue time (inadmissible selections 400 before any approval exists); dispatch reuses the frozen route verbatim and `revalidateCodingRoute` fails the run when the connection was revoked between approve and dispatch. `queue_run` MCP tool now accepts `harness` (agent-native parity with the dashboard composer). Coverage: `test/model-policy.test.ts` (11 cases) + orchestrator/lane suites.
- **GitHub Projects v2 sync.** `github-project.ts` adds the published PR to the configured board and sets its status; `syncProjectBoard` runs via `ctx.waitUntil` — best-effort, never delays the terminal transition (ce reliability finding).
- **ce-code-review fixes (11 reviewers, verified):** chat approval cards no longer truncate the task into invisibility — oversized tasks post in full as thread chunks (Telegram 3900-char, Discord 1900-char) and the card shows the frozen route; `telegramApi`/`discordApi` bounded at 30s; legacy approvals carrying `harness` (no `route`) still dispatch with the approved agent; `repoPullUrl` accepts scraped PR links only via a structural `owner/repo/pull/N` match (prefix confusion refused); automations dedupe sweep chunks deletes past the 128-key `storage.delete` cap; waitlist returns uniform 200 with `alreadyJoined` in the body (status code no longer enumerates the list); ApprovalsView "approved" filter no longer admits rejected records; Tooltip re-measures after portal mount; MemoryTab reload/recall race resolved with a request-token guard; copy/notice timers restart instead of stale-clearing; `SECRET_SHAPED` covers more credential prefixes.
- Verified: `pnpm typecheck` ✓, `pnpm lint` (touched files) ✓, `pnpm test` 1178/1178 ✓, `pnpm build` ✓ (38 pages, 1678 links). Live Telegram/Discord chat still unverified — same cloud-deploy blocker as T10.

**2026-09-24 (post-merge code-review remediation — team findings, 995 tests)**
- **MCP run isolation (HIGH).** `run_status`, `list_runs`, and `list_approvals` moved from `sandbox:exec` to a new `runs:read` scope, and runs/approvals now carry `queuedBy` stamped from the worker-vouched `X-Agent-Principal` header at intake. The orchestrator filters `GET /api/runs`, `GET/DELETE /api/runs/:id`, and `GET /api/approvals` to the calling principal when the header is present — one agent token can no longer read another agent's task text, diffs, errors, or PR URLs. Agent principals get 403 on `POST /api/approvals` (decisions stay human) and on `DELETE /api/runs` (registry clear stays operator-only).
- **Deploy footgun (HIGH).** `alchemy.run.ts` now warns when a live stage deploys without `DashboardAccess` — `REQUIRE_ACCESS` still fails closed, but the operator sees that every request will 401 unless an external Access app fronts the hostname.
- **`list_runs` performance (MEDIUM).** `GET /api/runs?limit=N` slices newest-first inside the DO; the tool no longer fetches the full registry to return 20 rows.
- **Bypass-path drift (MEDIUM).** `check-alchemy-drift.mjs` now asserts every `ACCESS_BYPASS_PATHS` entry has a Worker auth exemption (`SIGNATURE_AUTHENTICATED`, `isMcpPath`, `parseAutomationWebhookPath`) and that no signature route is missing from the bypass list.
- Verified: `pnpm typecheck`, `pnpm lint`, `pnpm test` (995 pass incl. new isolation/scope-denial cases), `pnpm build`, both drift scripts — all green. Commit `5bb0766` on `main`.

**2026-09-23 (reskin-dashboard branch — VERIFICATION_PLAN gap closure + reskin consistency, 10-agent team, 961 tests)**

Multi-agent pass closing VERIFICATION_PLAN.md §3 gaps and finishing the Inter + slate/navy reskin. All local gates green post-change: `pnpm typecheck` (tsc + astro check, 0 errors), `pnpm lint`, `pnpm test` (961 pass / 6 skip, 60 files), `pnpm build` (24 pages, 1036 links, 20 markdown stale-claim scan).

- **G1 dead model default — already resolved post-restructure; regression test added.** `backend/src/harness/index.ts:54` defaults to `google/gemini-3.5-flash-lite`; orchestrator has no `gemini-2.0`. New `backend/test/no-dead-gemini-2.0.test.ts` fails if the retired id reappears outside the intentional deny-list files.
- **G2 startup assertion — already present, now first-request gated.** `assertLiveCodingModel` (RETIRED_CODING_MODELS deny-list, `backend/src/coding-model.ts`) runs at `backend/src/index.ts:1014` behind a module flag that flips only on a non-throwing call — a retired `CODING_MODEL` still fails every request. New `backend/test/coding-model-startup.test.ts` (module-reset per test, order-independent).
- **G3 stale 503/WORKER_ORIGIN docs — already fixed by 310c62d; verified.** `scripts/check-docs.mjs` gate exists and runs via `docs:verify` in `pnpm build`. Remaining grep hits are legitimate (negated "no provider callback", real webhook 503 for missing `GITHUB_WEBHOOK_SECRET`).
- **G4 GOAL.md Slack — extended.** `spec/GOAL.md` inbound-surface paragraph now names `SLACK_CHANNEL_REPOS` (channel→repo mapping) alongside `SLACK_APPROVERS`.
- **G5/G6 dead files — already removed upstream (22217d6).** `backend/src/costs.ts`, `backend/test/costs.test.ts`, `spec/COMPLETION.md` confirmed absent; no references remain.
- **G7 unbuilt-feature docs — already absent; claude-code.mdx reworded.** review.md/jira.mdx/multi-agent.mdx not in tree or nav; claude-code.mdx no longer uses the literal "npm install" claim.
- **VERIFICATION_PLAN.md updated.** G1/G2/G5/G6 rows marked RESOLVED with current evidence; all pre-restructure paths corrected to `backend/` layout.
- **Reskin consistency — 69 hardcoded old-palette hex values → CSS vars** across 12 `frontend/src` files (`var(--panel)/--line/--muted/--text`). Verifier caught that Tailwind 3.4 emits no CSS for `var()` + opacity modifier; the 9 affected classes rewritten as `color-mix(in_srgb,...)` and confirmed present in emitted CSS. Landing `index.astro` cream `.section-light` features section converted to the page's dark token system.
- **Monorepo rules — root `typecheck` now covers web.** Was bare `tsc --noEmit` (web/ never checked); now `tsc --noEmit && pnpm run docs:check`. `pnpm install` run — turbo/frontend node_modules were stale, which had masked a `next-themes@0.4.6` + `@types/react@19.2.18` types bug (ThemeProviderProps drops `children`); fixed with a one-line cast in `frontend/src/components/ThemeProvider.tsx` pending upstream fix.
- **Flagged, not fixed (needs decision):** `web/package.json` has no `lint` script — `turbo run lint` silently skips Astro/MDX (fix needs an eslint-astro plugin dep). `.gitignore` ignores `.agents/` while 2 files under it are already tracked — new skills would go silently untracked.

**2026-09-19 (missions + quality gates surfaces — 407 tests)**

Factory/Droid-parity surfaces, verified live on `wrangler dev` (:8788):

- **Missions** (`dashboard/src/components/MissionsView.tsx`): standing goals as `mission: true` automations — a scheduled trigger carries a `run_when` gate ("does this goal still have unfinished work?") plus a manual check-in trigger. `Automation.mission` added to the record, `CreateAutomationInput`, and create path (`src/automations.ts`); `publicAutomation` serializes it. Live-verified: `POST /api/automations` with `mission:true` → stored, listed, serialized; `POST /api/automations/{id}/run` fired the check-in and the queue refused (400 — automations request `publishPullRequest`, no `GITHUB_TOKEN` locally: fail-closed as designed). Honest scope: recurring gated check-ins, not checkpointed multi-day processes — no resumable agent memory between runs.
- **Quality Gates** (`dashboard/src/components/GatesView.tsx`): Code Review / QA / Security Review cards that build typed task prompts and queue through the same `POST /api/runs` approval path. Live-verified: security gate prompt → `200`, `approvalId` issued, pending approval persisted. No bypass — a human still approves before a container starts.
- Dashboard nav extended (`Missions`, `Gates` tabs + deep links `?tab=missions`, `?tab=gates`); 2 new render tests.
- **Docs**: `automations.md` Missions section, `dashboard.md` Missions/Gates section, `configuration.md` harness/subscription boundary — Claude Pro/Max and ChatGPT Plus/Pro subscription credentials are deliberately unsupported (provider terms); BYOK API keys on the user's own AI Gateway are the path. Devin CLI: no published headless CLI exists (`devin-cli@0.0.1` is a 205-byte placeholder) — no harness wired, documented rather than faked.
- Suite green: typecheck, lint, 407/407 tests, build (25 pages/1101 links), `wrangler deploy --dry-run`.

**2026-09-19 (self-serve onboarding lane + audit-gap closure — 405 tests)**

Onboarding/deploy-simplicity work, all verified against local `wrangler dev` (:8788) and the test suite:

- **`GET /api/setup/status`** (`src/setup-status.ts`): live booleans for every required binding/secret — Slack (signing secret, bot token, approver count, channel repos), GitHub (token, webhook secret), AI Gateway (token configured + a real reachability probe — observed `unauthorized` locally, matching the 401 seen in the e2e run), Access requirement, model names, automation/TypeSafe flags. No secret values are ever returned.
- **`slack-app-manifest.yaml`**: import at api.slack.com/apps → "From a manifest" creates the app with the exact scopes, `app_mention` event, `/shiba-ai-coworker` command, and interactivity URL the code expects. Hostname is the only edit.
- **`pnpm setup`** (`scripts/setup.mjs`): one-command bootstrap — wrangler auth check → deploy → per-secret `wrangler secret put` prompts (skippable) → prints manifest + URLs. stdlib-only, no new deps.
- **OnboardingModal live status**: fetches `/api/setup/status`, auto-checks detected steps ("detected live" badge), merges with the localStorage manual checklist; progress counter counts detected steps.
- **Slack post-back** (`orchestrator.postToSlackThread`): thread-keyed DO names (`slack:{team}:{channel}:{ts}`) parse back to channel+thread; run start, completion (summary incl. PR link), error, and cancellation post into the originating thread via `chat.postMessage`. Best-effort `waitUntil` — never touches the run record. Non-Slack orchestrators and missing bot token no-op. Covered by two new orchestrator tests (posts to C9/1700.0001; skips `default`).
- **Manual automation trigger**: `POST /api/automations/{id}/run` fires one automation (targeted `fireEvent` with store merge — the filtered result list merges back into the full store). Verified live: missing id → 404 `Automation not found`, non-manual trigger → 400 `Automation has no manual trigger`, manual fire → reached the orchestrator and was correctly refused `Queue failed (400)` because automations always request `publishPullRequest` and no `GITHUB_TOKEN` is set locally — fail-closed working as designed.
- **Durable Slack event dedupe**: the in-memory ring stays the same-isolate fast path; a new `POST /internal/dedupe` on the Automations DO (`dedupe:{key}` in DO storage, 1-hour expiry) covers retries landing on another isolate. Fail-open — a dedupe backend error still acks and dispatches (duplicate beats lost). Two new slack-events tests cover both directions.
- **`groupMessageBursts` wired** (was dead code): `gatherSlackContext` collapses same-author rapid messages into one burst line (`⋮` separator, `+N` count). Plus the PLAN semantic at fire time — slack-trigger automations suppress a matching event inside `burstWindowSeconds` (default 10s, clamped 1–300) of `lastTriggeredAt`, checked before any `run_when` model call. Four new runner tests.
- `wrangler deploy --dry-run` re-verified green; `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all green at 405 tests.

**2026-09-19 (local end-to-end run — three real runtime bugs found and fixed)**

The first `wrangler dev` boot failed with `Disallowed operation called within global scope`, which `--dry-run` never catches (it builds but never evaluates the bundle). Two dependency-level offenders, both patched via `pnpm patch` (`patches/`):

- `brace-expansion@5.0.12` — `Math.random()` sentinel strings at module top level (`\0SLASH<rand>\0` etc.), pulled in via `minimatch@10` ← `just-bash` ← `@cloudflare/think`/`agents`. Sentinels replaced with fixed strings; collision risk is nil for the literal `\0` markers.
- `chat@4.40.0` — `var NEVER_ABORTED_SIGNAL = new AbortController().signal` at module top level, via `@cloudflare/think` + `agents`. Lazy `getNeverAbortedSignal()` now constructs it on first use.

And one repo bug that only surfaces at runtime:

- **`src/sandbox.ts` egress handlers were dead.** `static get outboundHandlers`/`outboundByHost` overrode accessors whose *setters* populate the base `Container`'s module-level registries — the getters read fine but registered nothing, so `setOutboundByHost` threw `Outbound handler method 'githubScoped' not found` and every static handler (`denyUnscopedGitHub`, provider forwarders) never dispatched: github.com fell through to plain `fetch` once allowlisted. Both are now plain setter assignments evaluated at module init, which registers them under class name `Sandbox` in every context that loads the module.
- **`wrangler.jsonc`** gained `enable_abortsignal_rpc`: `sandbox.exec({signal})` passes the run's AbortSignal over RPC for cancellation; without the flag workerd throws `AbortSignal serialization is not enabled`.
- `test/runtime.test.ts` egress tests updated for the registry-backed accessor types (`| undefined`, required handler ctx arg).

**2026-09-19 (inspo-driven dashboard redesign & full end-to-end UI polish)**
- **Inspo-driven Design System & UI Skills Integration:** Reshaped the entire dashboard surface using Inspo MCP references (Buildkite, LlamaIndex, Anima, Tabnine) and UI-skills (@vercel-labs/web-design-guidelines, @s0xdk/refactoring-ui, @mengto/beautiful-shadows, @mengto/container-lines). Standardized obsidian elevation, hairline guides, layered shadows, live telemetry ribbon, and unified status tokens across all 5 views.
- **Landing Page Integration:** Connected live dashboard (/app/) in landing nav, hero CTA, and footer.

**2026-09-18 (end-to-end onboarding & UI-skills refinement)**
- **Interactive Setup & Onboarding Checklist (`dashboard/src/components/OnboardingModal.tsx`):** Implemented the 6-pillar setup checklist covering Workers Paid SQLite storage, AI Gateway BYOK keys, Zero Trust Access bypasses, scoped GitHub PAT isolation, Slack bot allowlist, and first acceptance run. Refined with UI-skills (`pbakaus/harden`, `ibelick/baseline-ui`) with segmented filter tabs (All/Pending/Completed), checklist reset, copy-feedback, tabular numbers, and full accessibility attributes (`role="progressbar"`, `role="checkbox"`, `role="dialog", `useId`).
- **Dashboard integration:** Added header Setup Guide launch button, empty-state onboarding card CTA, Escape hotkey handling, and starter task prefill.
- **Documentation (`web/src/content/docs/docs/onboarding.md`):** Complete walkthrough published and verified at 23 HTML pages and 1012 links.

**2026-09-18 (per-run harness selection + live TypeSafe check)**
- **End-to-end harness selection.** The dashboard's New Coding Task form now picks the harness per run (OpenCode / Claude Code / Codex). `delegate_coding_task` accepts optional `harness` and `codingModel`; the orchestrator resolves them at approval time — an unknown harness or a harness/model mismatch fails on the approval card, never inside a container the human already approved. The child agent runs the approved harness, not the deploy default (`AGENT_HARNESS` remains the fallback). Per-harness models: `CODING_MODEL` (OpenCode), `CLAUDE_CODE_MODEL` (default `anthropic/claude-sonnet-4-6`), `CODEX_MODEL` (default `openai/gpt-5.3-codex`).
- **One image, three CLIs.** The Dockerfile installs `opencode-ai@1.18.31`, `@anthropic-ai/claude-code@2.1.277`, and `@openai/codex@0.155.0`, and the build fails unless every binary reports its version. A Docker run confirmed all three execute inside the container (amd64 emulation).
- **LIVE TypeSafe check added** (`test/typesafe-live.test.ts`, `pnpm test:live`). Auto-skips without a key; with `TYPESAFE_API_KEY` (env or `.dev.vars`, gitignored) it proves the three wired integrations against the real System One API: Noul run_when gate (matching runs, newsletter skips — fail closed both ways), Choice Slack intent, Score result quality. Mocked tests cannot establish any of this.
- Fixed type/lint errors in the concurrently-added `src/sandbox-routes.ts` (`timeoutMs` → SDK's `timeout`; narrowed a possibly-undefined regex capture) and removed the now-dead `DEFAULT_CODING_MODEL` constant in the orchestrator.

**2026-09-18 (code-review findings pass)**
- One TypeSafe System One client (`src/typesafe.ts`): `postSystemOne` + typed `readNoulAnswer`/`readChoiceAnswer`/`readScoreAnswer` replace the three hand-rolled copies of the endpoint constant, Bearer envelope, and null-on-error handling in `automations.ts`, `result-quality.ts`, and `slack-mention.ts`. Policy stays in the callers — the run_when gate fails closed, intent classification and quality scoring fail open.
- Dead TypeSafe grade fixed: the orchestrator previously annotated quality via a `completed` transition that `transitionRun` silently discards on terminal runs. The grade now lands as a `grade` receipt on the finished record (pinned by a new test in `test/runs.test.ts`).
- Removed the stop/resume/fork snapshot feature: PLAN.md §0 cuts snapshots and §4 files resumable runs under future work ("a real architecture change"). Deleted `src/snapshots.ts`, the `SNAPSHOTS` R2 binding, the `stopped` status and `snapshotKey`/`parentRunId`/`skipClone` fields, and the `/api/runs/:id/{stop,resume,fork}` route acceptance that no handler implemented. The feature had zero test coverage.
- Automation webhook secret is header-only (`x-automation-secret`); the `?secret=` query-param fallback was removed because query strings land in access logs.
- Honesty fixes: README "Live Demo" badge and "Live Site & Deployment" section relabelled — the Pages site is static landing/docs/dashboard UI and the pipeline's status is local prototype until T10; docs sidebar "Live App ↗" → "Landing Page ↗"; PLAN.md §2.0 synced to rev 5 (374→375 tests, dry run green).

**2026-09-18 (review-findings pass)**
- Slack approval lane closed end to end: POST /api/runs queues a durable pending approval in the orchestrator DO (frozen delegation input, 30-min TTL, resolve-exactly-once, non-object bodies rejected at the route). Slash-command replies and `@mention` cards (`SLACK_BOT_TOKEN`) both carry Block Kit; `/api/slack/interact` resolves on the pointer `threadKey` DO (`default` for slash, `slack:{team}:{channel}:{thread_ts}` for mentions). Empty bot token: no mention card and no run. Repo: GitHub URL, else `SLACK_CHANNEL_REPOS`, else an in-thread ask.
- Run lifecycle: 30-minute deadline reclaim (reclaim-on-access), cancellation propagation via per-run AbortController, terminal runs immutable, sandbox destroyed on cancel/reclaim/finish.
- Capture integrity: oversized trees fail the run instead of publishing a partial PR; `..` now rejected as a whole path segment only.
- Dead cron trigger removed from wrangler.jsonc (finding #4); dashboard identity via /api/whoami (finding #5).
- Correctness-pass fixes: porcelain octal escapes decode as UTF-8 (non-ASCII paths no longer fail change collection); approve preflights concurrency cap/token/URL before consuming the pointer (409 keeps it retryable); run deadline 30 -> 45 min, above the worst-case phase budget.

**2026-09-17 (earlier pass)**
- T6: scoped the GitHub credential per run; extracted `src/egress.ts` so the security-critical handlers are testable at all (`src/sandbox.ts` imports `cloudflare:` builtins and cannot load under vitest).
- T19/T20: `run_when` gate and the three automation safety controls.
- B10: `MAX_CONCURRENT_RUNS` 3 → 5, matching `max_instances`. The tests hardcoded 3 and are now limit-relative.
- T4 residual: removed `CF_ACCOUNT_ID` from `src/env.ts` and the stale `gemini-2.0-flash` reference.

**Earlier**
- Typecheck errors (5): dashboard import path, missing runtime test imports, unused label.
- Test failures (7): `streamProgress` propagating `OpenCodeErrorEvent` instead of swallowing it; `runCodingTask` returning error details; `collectChanges` skipping deleted files; `redactSecrets` covering `AI_GATEWAY_TOKEN=`; progress cap counting only streamed events.
- Lint errors (2): unused `signal` param, unused label.
- **TypeSafe Choice intent wired** (handleSlackEvent). When TYPESAFE_API_KEY is set, classifySlackMentionIntent classifies Slack mention intent (fix/implement/explain/other) and prepends an intentHint sentence to the queued task. Fail-open — null leaves task unchanged. SlackMentionDeps.typeSafeFetch allows test injection. 374 tests include the wired path with mock fetch.
- **TypeSafe Score result wired** (orchestrator.ts finish completed). When TYPESAFE_API_KEY is set, evaluateResultQuality scores run output quality and annotates the run summary with the grade level. Fire-and-forget — never delays run completion.
- **TypeSafe Score result quality** (src/result-quality.ts). evaluateResultQuality returns null on missing key, HTTP errors, parse failures, and network errors; parses score + confidence + level correctly; sends the correct Score request shape.
- **TypeSafe Choice intent classification** (src/slack-mention.ts classifySlackMentionIntent). Returns null on missing key, empty mention, HTTP/parse/network errors; classifies fix/implement/explain/other; maps unknown choices to other; sends correct Choice request shape. intentHint returns sharpened prompt text per intent.
# 2026-09-26 — Shiba email API and attachment download

- Added an Access-gated OpenAPI 3.1 contract at `GET /api/email/openapi.json` for the existing mailbox, email, thread, and draft routes. It explicitly documents that `POST /api/drafts/:id/send` queues approval rather than sending.
- Closed the attachment path: the Inbox links to `GET /api/emails/:id/attachments/:partId`; the Worker resolves the R2 key only from a registered mailbox's attachment manifest and forces a no-store binary download. Tests cover a valid download, a forged part id, a missing object, and an unauthenticated request.
- Local verification: six focused email test files passed (193 tests); `pnpm typecheck`, `pnpm lint`, `pnpm test` (1174 passed, 6 skipped), `pnpm build` (including docs verification), and `npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc` all passed. `wrangler dev` served `GET /api/email/openapi.json` with HTTP 200 and the expected `downloadAttachment` operation. No deployment or live Email Routing/Email Sending test was performed; account provisioning and real delivery remain unverified.
