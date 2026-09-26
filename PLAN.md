# AI Coworker — End-to-End Completion Plan

**Revision:** 2026-09-27 (rev 9). Adds §17, Phase P7 — Roomote parity (T27–T36). Rev 3's §2 "genuinely broken" table is now largely historical — see §2.0 for what is actually left.

**Target:** an open-source, self-hosted [Capy](https://capy.ai)/[Hoplite](https://hoplite.sh)-shaped coding agent that runs entirely on the user's own Cloudflare account. Scope is Capy's **spine plus review and automations** — not its workspace layer. See §4 for what is deliberately not being built.

**Verdict:** the architecture is right and further along than it looks. Four deploy-breaking config bugs stand between this repo and a first real cloud run; everything after that is product surface that reuses one pipeline.

---

## 0. TL;DR

| | |
|---|---|
| **Keep** | Worker + Think orchestrator + AIChatAgent + Sandbox. Approval gate. Egress interception (`src/sandbox.ts`). The dashboard — it is already functional. |
| **Fix first (P0)** | SQLite migration · instance type · **dead model default** · the `WORKER_ORIGIN` path that makes every run throw |
| **Then (P1–P2)** | Egress allowlist · per-run GitHub token scoping · Access · structured result parsing · one proven live run |
| **Then build (P3–P4)** | Slack bot end to end · automations (cron, GitHub events, Slack bursts, webhooks) |
| **Then unlock (P5)** | **Bring your own agent and model** — pluggable harness (OpenCode / Claude Code / Codex) and any provider. The differentiator neither Capy nor Hoplite can offer. |
| **Cut** | Multi-tenancy · snapshots · multi-repo projects · Linear/Tailscale/Vercel · cost-estimate UI · rename tracking |
| **Ceiling** | `standard-4` (4 vCPU / 12 GiB / 20 GB) is Cloudflare's max. Capy goes to 16 vCPU / 128 GB. Heavy builds are out of reach — say so in the README. |
| **Effort** | P0 ≈ 3h · P1 ≈ 5h · P2 ≈ 5h · P3 ≈ 14h · P4 ≈ 10h · **P5 ≈ 14h** · P6 ≈ 4h → **~55h** |
| **Rev 4 status** | All of the above is **done except T10** — the live run is now verified locally via `wrangler dev` up to the model call (AI Gateway credential needed); the cloud deploy itself is still blocked on GOAL.md. See §2.0. |
| **Rev 9 status** | §17 (P7, Roomote parity) is **planned, not started**. ~80% of Roomote's spine already ships; the delta is OAuth MCP, web chat + steering, and screenshot/preview. Recommended scope W0–W3 ≈ 43h. T27 (spec/monorepo contradiction) gates all of it. |

---

## 1. Evidence Reviewed

**Local** (read-only; no repo scripts run beyond `npm test`): `src/` in full, `dashboard/app.tsx`, `wrangler.jsonc`, `package.json`, `Dockerfile`, `spec/GOAL.md`, `README.md`, `readiness.md`, `test/`. `npm test` → **111/111 pass** (2026-09-17).

**External** — all observed **2026-09-17**, via Exa, `gh`, Cloudflare Docs MCP, Context7, Jina Reader.

| Claim | Source | Limit |
|---|---|---|
| `instance_type` defaults to `lite` (1/16 vCPU, 256 MiB, 2 GB) | [wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/) | Does not prove OpenCode OOMs — inferred |
| Sandbox needs `new_sqlite_classes` | [sandbox/get-started](https://developers.cloudflare.com/sandbox/get-started/) | Shown for `Sandbox`; Agents DOs also need SQLite |
| Containers: per-10ms billing; $5 Workers Paid includes 25 GiB-h / 375 vCPU-min / 200 GB-h | [containers/pricing](https://developers.cloudflare.com/containers/pricing/) | Rates change |
| CPU bills on **active** use; memory and disk on **provisioned** | [containers changelog](https://developers.cloudflare.com/changelog/product/containers/) | — |
| Container max is `standard-4`: 4 vCPU / 12 GiB / 20 GB | [containers/limits](https://developers.cloudflare.com/containers/platform/limits/) | Custom types capped at the same ceiling |
| DO: 1M requests + 400,000 GB-s included; bills 128 MB regardless; **`accept()` on a WebSocket bills for the whole connection** | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) | Hibernation API avoids it — unverified whether `agents` uses it |
| `allowedHosts` is deny-by-default, evaluated before outbound handlers | [outbound-traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) | — |
| TLS interception: per-instance ephemeral CA, key never leaves the sidecar | [changelog 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/) | — |
| `needsApproval` on plain `getTools()` = client-side approval | [think/tools](https://developers.cloudflare.com/agents/harnesses/think/tools/) | `pendingExecutions()` is for code-mode tools, which we do not use |
| **`gemini-2.0-flash` was shut down 2026-06-01** | [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) | — |
| Gemini 3.8 Flash: $0.75/M in, $3.75/M out — **both double 2027-01-01** | [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) | — |
| Anthropic: OAuth is for "ordinary use"; **third parties may not route requests through Free/Pro/Max credentials on behalf of users** | [Claude Code legal](https://code.claude.com/docs/en/legal-and-compliance) | Self-hosted own-subscription use is gray, not clearly permitted |
| Slack: `app_mentions:read`; `url_verification` challenge; v0 HMAC; `block_actions` payload; 3s ack | [docs.slack.dev](https://docs.slack.dev) | — |

**Gaps:** no live deployment attempted (GOAL.md forbids it). `wrangler deploy --dry-run` still fails on missing Docker. OpenCode's real memory ceiling never measured. OpenAI/Codex subscription terms not checked.

---

## 2. Corrected Current State

### 2.0 Status as of rev 8 (2026-09-26)

**Rev 8 (PR #17):** unified chat lane — Telegram webhook + Discord interactions share `chat-lane.ts` (one orchestrator conversation per chat/channel, approval cards are pointers, server-side approver allowlists) · GitHub Projects v2 board sync on PR publish (best-effort) · model connections + purpose policy + frozen `ApprovedRoute` (approve exactly this route; revalidated at dispatch) · iPhone `/api/trigger` lane (PR #13) · marketing site overhaul. ce-code-review fixes landed: full task text posts in-thread (no blind approval), route shown on the card, outbound chat APIs timeout-bounded, board sync is non-blocking, legacy `harness` approvals still dispatch correctly, dedupe sweep chunked past the 128-key limit, waitlist returns uniform 200.

Baseline: **1178 tests passing across 74 files**, typecheck and lint clean.

| Task | State |
|---|---|
| Telegram lane (`/shiba`, approval inline-keyboard, TELEGRAM_APPROVERS) | **Done.** Header-secret auth, update_id dedupe ring + durable dedupe, full-task chunks in-thread. Live chat unverified — same cloud-deploy blocker as T10. |
| Discord lane (`/shiba` slash command, button approvals, DISCORD_APPROVERS) | **Done.** Ed25519 + 300s replay window before parsing, deferred replies. Live interaction unverified. |
| Model connections + frozen routes | **Done.** `model-config-do.ts` persists the catalog (SECRET_SHAPED refs rejected), `model-policy.ts` resolves/revalidates; dashboard composer picks harness; `queue_run` MCP tool accepts `harness`. |
| GitHub Projects v2 sync | **Done.** `github-project.ts` + `opencode-agent.syncProjectBoard` (ctx.waitUntil — never delays the terminal transition). Requires GITHUB_PROJECT_TOKEN + GITHUB_PROJECT_NUMBER. |
| Marketing site (theme tokens, why-shiba, tooltip/touch/focus fixes) | **Done.** bezalel-style navy/cream tokens, both light/dark; coarse-pointer tap targets. |
| Cursor/Grok ACP harnesses | **In progress.** Both adapters ride the shared ACP transport (t3code method: one transport module + per-harness support shims) rather than bespoke argv/event parsers. |
| Connected agent accounts (dashboard) | **In progress.** Per-user credential accounts for connected agents — Worker API (`harness-accounts`) plus a dashboard surface to add/list/revoke. |

### 2.0 Status as of rev 7 (2026-09-19)

Baseline: **405 tests passing across 32 files**, typecheck and lint clean, `wrangler deploy --dry-run` green (OrbStack), and a **local `wrangler dev` end-to-end run** that exercised queue → signed Slack approval → DO dispatch → real container → scoped GitHub clone → harness exec → AI Gateway egress (model call blocked at gateway auth — account config, see VERIFICATION.md). Earlier counts ("374/30", "333/28", "269/21", "111/111") are stale everywhere they appear below.

| Task | State |
|---|---|
| T1 SQLite migration · T2 instance type · T3 live model id · T4 delete dead provider path | **Done.** |
| T5 egress allowlist · T7 Access gating · T8 result envelope · T9 progress streaming · T11 sleep tail | **Done.** |
| T12–T17 Slack: command + mention lanes shipped (queue → approval card → allowlisted click → thread-keyed DO resolve → frozen input runs). Empty `SLACK_BOT_TOKEN` = no mention card and no run. | **Done in code.** Live workspace still unverified (T10). |
| T18 automations trigger engine · T21 harness seam | **Done.** |
| T24 README · T25 deploy button · T26 pins | **Done.** |
| **T6 scoped GitHub credential** | **Done in rev 4.** `github.com` now defaults to *refusal*; `approveRepoScope("/owner/repo")` installs the scoped forwarder before the clone. Stricter than this plan's sketch, which left the open forwarder as the default. Handlers moved to `src/egress.ts` — `src/sandbox.ts` imports `cloudflare:` builtins and cannot load under vitest, which is why this code was previously untested. |
| **T19 `run_when` gate · T20 automation safety** | **Done.** TypeSafe Noul when `TYPESAFE_API_KEY` is set (noul ≥ 0.8 to run), else Workers AI YES/NO; both fail closed. Approval by default, narrow opt-in unattended mode, daily budget, two kill switches. |
| **B10 concurrency** | **Fixed in rev 4.** `MAX_CONCURRENT_RUNS` was still 3 while `max_instances` was already 5 — T2 had only been half-applied. |
| **T22 Claude Code / Codex adapters · T23 provider choice (B11)** | **Done in rev 4.** The seam had to widen first: `configPath` and the container env were still OpenCode-hardcoded in `runtime.ts`, so a second harness could not have worked. `AgentHarness` now owns `supportedProviders`, `egressHosts(model)`, `configFile()`, and `env()`. `allowedHosts` is narrowed per run via `approveHarnessEgress` to the selected harness's provider host plus git — never the union. All three CLIs ship in the image and the dry run verifies each binary. Caveat: only OpenCode has run live (locally, to the model call); the other two are unit-tested against their documented stream formats. |
| **T10 live acceptance run** | **Partially done locally (rev 6, 2026-09-19).** `wrangler dev` + OrbStack ran the full chain to the model call: queue → signed Slack approval → DO dispatch → real container → scoped GitHub clone → `opencode run` → AI Gateway **401** (needs `AI_GATEWAY_TOKEN` or BYOK key in gateway `default`). Cloud deploy still not performed — `spec/GOAL.md` forbids it from this environment. Evidence in VERIFICATION.md. |
| **Missions · Quality Gates (rev 7)** | **Done in code.** Missions = `mission: true` automations (standing goal, `run_when` gate per cadence, manual check-in) on a dedicated dashboard tab — recurring gated check-ins, not checkpointed multi-day agents. Gates tab queues Code Review/QA/Security task templates through the same `/api/runs` approval path. Both verified live locally. Devin now ships as a CLI harness adapter (`harness/devin.ts`, catalog entry, Dockerfile binary); subscription-credential passthrough (Claude Max/ChatGPT) stays deliberately unsupported per provider terms. |

**The honest summary:** every task that can be completed without a cloud account is done, and the local dev run now proves the pipeline mechanics end to end. **What remains is a cloud deploy plus an AI Gateway credential** (`AI_GATEWAY_TOKEN`, or a BYOK key on the `default` gateway) — account work, not more code.

**Two things this rev deliberately did not do.** `registry.npmjs.org` stays off the egress allowlist. (The one-image-per-harness question from §11 is now moot for boot — the single image carries all three CLIs and the dry run verifies them.)

### Already working — stop listing these as TODO

| Old claim | Reality |
|---|---|
| "Deletions broken" | Works. `src/github.ts:109-112` pushes `{sha: null}` for `content === null`. |
| "Dashboard is basic" | Form + PR checkbox (`dashboard/app.tsx:284-340`), approval cards (`:375-409`), live runs + diff (`:411-441`), retained runs with cancel (`:442-470`). |
| "Renames broken" | Rename = delete + add. Both sides already emitted. |
| Live preview impossible | **`proxyToSandbox` is already imported and wired** at `src/index.ts:6`. Preview URLs are one feature away, not one architecture away. |

### Genuinely broken

| # | Problem | Evidence | Impact |
|---|---|---|---|
| **B1** | `new_classes`, not `new_sqlite_classes` | `wrangler.jsonc:35` | Deploy fails or DOs lack SQLite |
| **B2** | No `instance_type` → `lite` (256 MiB) | `wrangler.jsonc:27-34` | OpenCode OOMs |
| **B3** | **`CODING_MODEL` points at a model shut down 2026-06-01** | `wrangler.jsonc:14`, `runtime.ts:49`, `provider-gateway.ts:28` | Every run fails at the model call |
| **B4** | Throws when `WORKER_ORIGIN` unset — guarding a path never read | `orchestrator.ts:122-128` | **Every delegation fails before a sandbox starts** |
| **B5** | Container may egress anywhere | `src/sandbox.ts:81-86` — `outboundByHost` but no `allowedHosts` | Untrusted code has open network |
| **B6** | `GITHUB_TOKEN` injected for **all** github.com traffic | `src/sandbox.ts:61-63` | Repo code can reach any repo the token can |
| **B7** | Nothing authenticates `/api/runs`, the agent WS, or child routes | `src/index.ts:74-101` | Public deploy is fully open |
| **B8** | Any string child output ⇒ `completed` | `orchestrator.ts:160-162` | Failed runs display as successful |
| **B9** | `sleepAfter = "10m"` + a unique sandbox id per task, never destroyed on success | `src/sandbox.ts:78`, `security.ts` `makeSandboxId` | **3× the compute bill** — the idle tail costs more than the work |
| **B10** | `MAX_CONCURRENT_RUNS = 3` and `max_instances: 3` | `src/runs.ts:29`, `wrangler.jsonc:32` | 4+ parallel projects impossible (Cloudflare's own default is 20) |
| **B11** | `buildOpencodeConfig` hard-rejects non-`google/*` models | `runtime.ts:295` | Users cannot bring a cheaper or better provider — §3, fixed by T23 |
| **B12** | The agent harness is hardcoded to OpenCode | `Dockerfile`, `buildOpencodeArgv`, `buildOpencodeConfig`, `parseOpencodeEvent` | Users cannot bring Claude Code, Codex, or Aider — fixed by T21/T22 |

### Dead code (B4's root cause)

`buildOpencodeConfig` (`runtime.ts:293-311`) **never reads `providerBaseUrl`**. No `baseURL` is written, so OpenCode calls the real `generativelanguage.googleapis.com`, which `Sandbox.outboundByHost` (`src/sandbox.ts:83`) intercepts and forwards through AI Gateway. **That path is complete and correct.** A second, inert implementation sits beside it:

```
orchestrator.ts:139    providerBaseUrl = `${WORKER_ORIGIN}/api/provider/google`  ← written, never read
opencode-input.ts:19   providerBaseUrl: z.string().min(1)                        ← validated, never used
index.ts:28-38         handleProvider() → 503                                    ← unreachable
provider-gateway.ts:23 forwardProviderRequest()                                  ← only tests call it
env.ts:23-25           CF_ACCOUNT_ID, WORKER_ORIGIN                              ← legacy
```

The fix is deletion, not wiring (T4).

---

## 3. Competitive Landscape

### Direct, on Cloudflare (from [awesome-cloudflare-selfhosted](https://github.com/theoephraim/awesome-cloudflare-selfhosted), 466★)

| Project | ★ | Last push | What transfers | What does not |
|---|---|---|---|---|
| [cloudflare/vibesdk](https://github.com/cloudflare/vibesdk) | 5,365 | 9 days | Same stack incl. AI Gateway + Containers; proves the pattern | Generates new apps, not repo fixes |
| [jonesphillip/weft](https://github.com/jonesphillip/weft) | 510 | **7 months** | Closest shape (task → agent → done) | **Stale.** Read its issues before assuming the niche is free |
| [nkzw-tech/cloudsail](https://github.com/nkzw-tech/cloudsail) | 161 | 4 months | Sandbox substrate | No approval gate, no PR publishing |
| [devarshishimpi/codra](https://github.com/devarshishimpi/codra) | 111 | **5 days** | Self-hosted PR review, actively developed | **Watch this one**: "review a PR" → "fix a PR" is one feature, and review is now out of scope (§4) |
| [acoyfellow/cloudbox](https://github.com/acoyfellow/cloudbox) | 53 | 2 months | **Receipts** (append-only evidence log) — a better answer to B8 than T8. Live run stop/resume/fork. Instance type as a deploy-time var | Bring-your-own-agent model; D1+R2+KV+Queues sprawl |
| [leo-ars/cloudflare-sandbox-coding-agent](https://github.com/leo-ars/cloudflare-sandbox-coding-agent) | 0 | 2 months | Per-run opaque token; PR-as-user so GitHub blocks self-approval | KV token store, OAuth impersonation |

### The SaaS this replaces

**[Capy](https://capy.ai)** — 70,000+ engineers claimed. Threads, tasks (parallel subagent trees), PRs with CI handling, a review agent, automations, projects, machines, snapshots, volumes, skills, six integrations, a full REST API.

**[Hoplite](https://hoplite.sh)** — $99/seat/mo. project → thread → sandbox → PR, approvals on sensitive actions, Slack, Linear, webhook and schedule automations, Modal sandboxes.

**Both are ahead on product. Both are closed SaaS.** The defensible position is the one neither can occupy: open source, the user's own account, no seat fee, no vendor holding the code. At §8's numbers that is ~$5–12/month against $99/seat.

**That pitch only works if users can bring their own cheap model** — which is why **B11** is load-bearing, not cosmetic. If people are locked to one provider, "self-hosted" saves them the seat fee and nothing else.

### On bringing a Claude Code / Codex subscription

Tempting — §8 shows tokens are ~40× compute, so a subscription would make this near-free to run. **Do not build it.** Anthropic's terms are explicit: *"Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."* Hoplite hit this and engineered around it — subscription agents run **locally on the user's Mac**, cloud sandboxes use API keys. When a funded competitor builds a native macOS app to avoid doing a thing, that is the signal.

Self-hosted own-subscription use is grayer than a SaaS doing it, but shipping it as a documented feature is facilitating it, and the person who loses their Max plan is your user. **Ship B11 instead:** make the provider configurable and let users point it wherever they want.

---

## 4. Cut From Scope (and why)

| Cut | Reason |
|---|---|
| **Multi-tenancy / per-user DOs** | GOAL.md: *"Each installation is single-tenant and account-owned."* — **§17.7 (T35) proposes revisiting this as a product decision. Not code; a spec change.** |
| **MCP integrations** | Each is its own auth surface for one workflow. — **§17.3 (T29) now builds one first, the OAuth MCP server, because it is the parity gap, not a cut.** |
| **Machine snapshots** (Capy's 1–2s restore) | No Cloudflare equivalent. Partial substitute: fatten the Dockerfile, or R2 FUSE mounts for `node_modules`. Not equal — say so. |
| **Machines > `standard-4`** | Hard platform ceiling: 4 vCPU / 12 GiB / 20 GB vs Capy's 16 vCPU / 128 GB. Heavy builds and big test suites are out of reach. **README, not a surprise.** |
| **Multi-repo projects, volumes, skills, environments** | Capy's workspace layer. Real work, no pipeline reuse. Revisit after P4. |
| **Linear / Tailscale / Vercel / MCP integrations** | Each is its own auth surface for one workflow. |
| **Cost-estimate UI** | Old plan hardcoded invented rates. GOAL.md: *"Cost surfaces without invented prices."* Link §8 instead. |
| **`renames[]` field** | Redundant — see §2. |
| **Wiring `/api/provider/google`** | Duplicates a working path. Delete (T4). |
| **`CF_ACCOUNT_ID`, `AI_GATEWAY_TOKEN`** | Already marked legacy in `.dev.vars.example`. Keep `AI_GATEWAY_TOKEN` only for an authenticated gateway. |
| **Subscription proxying (Claude Code / Codex)** | Prohibited by Anthropic's terms — see §3. |

### Future work — not planned, not forgotten

Noted so the next reader knows these were considered rather than missed. None of them are on the critical path; none are scheduled.

- **PR review agent** (~9h). A `review_pull_request` tool: clone at the PR head so the agent reads surrounding code rather than diff context alone, emit `{path, line, severity, comment}` findings, publish via `POST /repos/{o}/{r}/pulls/{n}/reviews` as `COMMENT` — never `APPROVE`, an agent must not approve. Reuses the whole pipeline with a different prompt and a different endpoint, so it stays cheap whenever it returns. Competitive cost, stated plainly: [Codra](https://github.com/devarshishimpi/codra) exists solely to be this, and Capy and Hoplite both ship one.
- **PR feedback loop** (~4h, needs the review agent). Extend `/api/github/webhook` to `pull_request_review_comment`; a comment mentioning the bot on an shiba-ai-coworker PR starts a run against that PR's branch and replies on the same thread.
- **Live preview URLs.** **Shipped in rev 8** — `index.ts:1093-1099` proxies to the sandbox. Screenshot capture remains open; see §17.5 (T33).
- **Resumable runs.** Stop/resume/fork, the way Cloudbox does it, for work exceeding `OPENCODE_TIMEOUT_MS`. A real architecture change, not a tuning knob (§16).

**Slack was cut in rev 1 and restored in rev 2.** The rev-1 reasoning was right about the spec and wrong about the product: what was cut was a slash command duplicating the dashboard; what is now built is the place work starts and finishes. `spec/GOAL.md` is consequently stale — its 11-step contract is dashboard-only and anticipates no second inbound surface. **T17 updates it.** Leaving it means the next reader cuts Slack again.

---

## 5. Phase P0 — Make Deployment Possible (~3h)

Nothing below this line matters until P0 lands.

### T1 · SQLite migration

Sandbox SDK requires the SQLite storage backend; Agents DOs persist the same way. `new_classes` gives the legacy KV backend.

```jsonc
// wrangler.jsonc:35 — before
"migrations": [{ "tag": "v1", "new_classes": [...] }],
// after
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CodingOrchestrator", "OpenCodeAgent", "Sandbox"] }],
```

**Caution:** editing `v1` in place is safe only if this Worker has never deployed. Otherwise add a `v2` — Cloudflare rejects modified historical migrations.

### T2 · Instance type and concurrency

Unset → `lite` → 256 MiB. A Node coding CLI plus a git tree does not fit.

```jsonc
// wrangler.jsonc:27-34
{
  "class_name": "Sandbox",
  "name": "shiba-ai-coworker-sandbox",
  "image": "./Dockerfile",
  // lite (the default) is 256 MiB / 2 GB disk — too small for OpenCode + a clone.
  "instance_type": "standard-1",
  "max_instances": 5,
},
```

Raise `MAX_CONCURRENT_RUNS` in `src/runs.ts:29` to 5 to match (**B10**). Cloudflare's own default is 20, so 5 is purely your policy.

**Measure before settling on `standard-1`.** §8 shows memory is the billing constraint: `basic` (1 GiB) yields **4× the free-tier runs** of `standard-1`. If OpenCode fits in 1 GiB, take it. Confirm during T10, and make the size a var — Cloudbox does this and it is right, since a large monorepo needs `standard-2`.

### T3 · Replace the dead model default

**`gemini-2.0-flash` was shut down 2026-06-01.** Update `wrangler.jsonc:14`, `runtime.ts:49`, `provider-gateway.ts:28`, and the test fixtures to a current model (`google/gemini-3.5-flash-lite` for cost, `google/gemini-3.8-flash` for capability).

Add a startup assertion so the next retirement fails loudly at deploy rather than silently at run time, and note in `configuration.md` that model ids retire — with a link to [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).

### T4 · Delete the dead provider path (unblocks every run)

1. Remove the `origin` guard (`orchestrator.ts:122-128`) and `providerBaseUrl` (`:139`).
2. Drop `providerBaseUrl` from `codingTaskInputSchema` (`opencode-input.ts:19`).
3. Delete `handleProvider` (`index.ts:28-38`) and its dispatch (`:89-92`).
4. Delete `WORKER_ORIGIN`, `CF_ACCOUNT_ID` from `src/env.ts` and `.dev.vars.example`.
5. Delete `forwardProviderRequest` and its tests. **Keep** `sanitizeContainerHeaders`, `stripCredentialParams`, `DUMMY_PROVIDER_KEY`, `GOOGLE_API_HOST` — `sandbox.ts` and `runtime.ts` use all four.
6. Drop `providerBaseUrl` from fixtures in `test/{opencode-input,transcript,runtime,opencode-agent}.test.ts`.
7. Add the regression test that catches this class of bug:

```ts
it("targets the real Google host so Sandbox egress interception applies", () => {
  const google = (buildOpencodeConfig(sampleInput).provider as any).google;
  // No baseURL: OpenCode must hit generativelanguage.googleapis.com so
  // Sandbox.outboundByHost can swap in the AI Gateway credential.
  expect(google.options.baseURL).toBeUndefined();
  expect(google.options.apiKey).toBe(DUMMY_PROVIDER_KEY);
});
```

8. `README.md:5` and `readiness.md` both lead with "provider callback disabled (503)". Rewrite: the callback is gone; provider traffic is intercepted at the Sandbox egress boundary.

**Verify:** `npm run typecheck && npm run lint && npm test`.

---

## 6. Phase P1 — Close the Security Boundary (~5h)

### T5 · Deny-by-default egress allowlist

`outboundByHost` routes two hosts; everything else falls through to the open internet. An allowlist is evaluated *before* handlers.

```ts
// src/sandbox.ts — deny-by-default. Anything unlisted cannot leave the
// container, including from repository code OpenCode runs.
static override get allowedHosts() {
  return [
    "generativelanguage.googleapis.com",
    "github.com",
    "codeload.github.com", // git clone fetches packs here
  ];
}
```

**Decide explicitly:** adding `registry.npmjs.org` enables `npm install` inside runs and is simultaneously the widest exfiltration channel on the list. **Ship without it in v0.1**, document the tradeoff, widen on a real request.

**Test:** the allowlist contains both intercepted hosts; a non-listed host is refused.

### T6 · Scope the GitHub credential to the run's repo

**Highest-severity finding.** `forwardGitHub` attaches `GITHUB_TOKEN` to *any* github.com request from the container.

```ts
// Only the repo this run was approved for gets the credential.
function forwardGitHubScoped(allowedPath: string) {
  return async (request: Request, env: EgressEnv): Promise<Response> => {
    const target = new URL(request.url);
    if (target.protocol !== "https:" || target.hostname !== "github.com") {
      return new Response("Invalid repository destination.", { status: 403 });
    }
    if (!target.pathname.startsWith(allowedPath)) {
      return new Response("Repository outside the approved scope.", { status: 403 });
    }
    return forwardGitHub(request, env);
  };
}
```

Bind via `setOutboundByHost()` in `createSandboxOps` (`opencode-agent.ts:32`) before the clone, using `/${owner}/${repo}` from `parseGitHubRepoUrl`.

*Stronger alternative, noted not built:* the `leo-ars` per-run opaque token. Path scoping gets most of the benefit for a fraction of the code. Revisit if task text ever comes from a third party.

**Tests:** approved repo carries `Authorization`; a different `owner/repo` returns 403 with no auth header.

### T7 · Authenticate every reachable path

**Layer 1 — Cloudflare Access.** Not code. Document it as a *required* step preceding the first deploy, in `deployment.md`.

**Layer 2 — fail closed in the Worker.**

```ts
// Signature-authenticated paths must not sit behind Access; Slack and GitHub
// cannot complete an Access login.
const SIGNATURE_AUTHENTICATED = ["/api/slack/", "/api/github/webhook"];

function isAuthenticated(request: Request, env: Env): boolean {
  const { pathname } = new URL(request.url);
  if (SIGNATURE_AUTHENTICATED.some((p) => pathname.startsWith(p))) return true;
  if (!env.REQUIRE_ACCESS) return true; // opt-out for `wrangler dev`
  return request.headers.has("cf-access-authenticated-user-email");
}
```

Gate `handleRuns`, `routeAgentRequest`, and asset fetch. **Write the exemption now even though Slack is P3** — see the sequencing note in §14.

**Limit, stated honestly:** a header check is not JWT verification. Anyone reaching the Worker origin directly can forge it. Document that the route must not be exposed outside Access; file JWT verification as v0.2.

**Tests:** with `REQUIRE_ACCESS`, unauthenticated `/api/runs` → 401; `/api/slack/events` is never gated.

### T8 · Parse the structured result

`orchestrator.ts:160-162` marks any string `completed`. The child already appends a `RESULT_MARKER` envelope; the parser just is not called.

```ts
// The child reports status in a structured envelope. Trusting the transport
// type instead would mark failed runs "completed".
const parsed = parseAgentResult(output);
finish(parsed?.status === "error" ? "error" : "completed", {
  summary: output.slice(0, 4000),
  error: parsed?.status === "error" ? parsed.summary : undefined,
});
```

Add `parseAgentResult` beside `formatAgentResult`, reusing `codingTaskResultSchema`.

*Worth knowing:* Cloudbox's **receipts** — an append-only evidence log (`init`/`read`/`write`/`submit`/`grade`) — is a structurally better answer than parsing a final envelope. T8 is the cheap version. If run trust becomes a recurring problem, adopt receipts rather than hardening the parser.

**Tests:** an `error` envelope → `error`; `completed` → `completed`; malformed/absent → `error`, never silent success.

---

## 7. Phase P2 — Prove One Real Run (~5h)

### T9 · Stream OpenCode's JSON events

`streamProgress` (`runtime.ts:100`) already parses events. Surface tool calls and file edits as they happen, keeping the `MAX_PROGRESS_EVENTS = 256` / 20,000-char caps. Without it a 5-minute run looks frozen.

### T10 · First live acceptance run

Follow `readiness.md`'s existing 9-step checklist verbatim on a throwaway repo. It is well written — do not rewrite it. Record results in `VERIFICATION.md` with date, versions, and every failure.

Minimum bar: deploy succeeds · dashboard behind Access, unauthenticated refused · reject → **no container starts** (verify in container metrics, not the UI) · approve → phases stream → diff matches reality · a failing task reports its real exit code · cancel mid-run stops the container · a PR lands with a deleted file shown as deleted.

**Also measure here:** peak container memory. That decides `basic` vs `standard-1` (T2) and, per §8, your free-tier capacity.

### T11 · Cold start and the sleep tail (fixes B9)

`sleepAfter = "10m"` plus a unique sandbox id per task means every 5-minute task bills **15 container-minutes** — the idle tail costs more than the work. Destroy the sandbox on successful completion (mirroring what `cancelRun` already does on cancel), or drop `sleepAfter` to `"1m"`. Cuts compute ~57% and triples free-tier capacity.

Separately: boot is slow because the Dockerfile installs `opencode-ai` globally. Render a distinct "starting container" state in the run list. If T10 shows boot exceeding 90s, raise `portReadyTimeoutMS` in `createSandboxOps`.

---

## 8. Cost Reality

All figures observed **2026-09-17**. Do not put them in the product UI — rates change and GOAL.md forbids invented prices. `costs.md` should link the official pages and name the *categories*.

### Cloudflare

$5/mo Workers Paid includes **25 GiB-hours** memory, **375 vCPU-minutes**, **200 GB-hours** disk. Overage: $0.0000025/GiB-s, $0.000020/vCPU-s, $0.00000007/GB-s. Billed per 10 ms. CPU on *active* use; memory and disk on *provisioned*.

**Memory is the binding constraint.** On `standard-1` (4 GiB): 25 GiB-h ÷ 4 = **6.25 container-hours/month included**. Disk allows 25 h, CPU allows 25 h — neither binds.

| Config | Per task | Free tasks/mo |
|---|---|---|
| `standard-1`, `sleepAfter = "10m"` (**today**) | 15 min | **25** |
| `standard-1`, destroyed after run (T11) | 5 min | **75** |
| `basic`, destroyed after run | 5 min | **300** |

Per container-hour: **$0.056** running at ~50% CPU, **$0.038** idle.

| Scenario | Tasks/mo | Compute | **+$5 base** |
|---|---|---|---|
| 1 project, 3/day | 66 | $0.37 | **$5.37** |
| 5 projects, 6/day each | 660 | $6.54 | **$12** |
| 5 projects, T11 applied | 660 | $2.36 | **$7.40** |
| 5 concurrent, 8h/day | — | $48.57 | **$54** |

**Parallelism does not cost more.** Billing is container-seconds; 5 tasks in parallel and 5 sequential cost the same. Parallelism buys wall-clock.

**Durable Objects** are a separate meter: 1M requests + 400,000 GB-s included, billed at 128 MB regardless of use. A 5-minute run costs 37.5 GB-s — ~10,600 runs fit. **But** `accept()` on a WebSocket bills for the entire connection: one DO connected 24/7 for a month is 328,500 GB-s, just inside the allowance; two open dashboard tabs exceed it. **Verify whether the `agents` SDK uses the WebSocket Hibernation API** — if not, that is a real bill.

### Models — the actual cost

Gemini 3.8 Flash: **$0.75/M input, $3.75/M output**, both **doubling 2027-01-01**.

One moderate task (~200K in, ~15K out): **$0.15 + $0.056 ≈ $0.21**, against $0.005 of compute.

| | 1 project (66/mo) | 5 projects (660/mo) |
|---|---|---|
| Cloudflare | $5.37 | $12 |
| **Tokens** | **~$14** | **~$139** |

**Tokens are 20–40× the Cloudflare bill.** Compute optimization is not where the money is — **B11** (provider choice) and prompt caching ($0.025/M vs $0.75/M) are. Input dominates because agentic loops re-send context every turn.

**Answer to "is $5 enough?":** yes, comfortably, for one project. Cloudflare is a rounding error on this product. ($5 is a monthly minimum, not a cap.)

---

## 9. Phase P3 — Slack Bot, End to End (~14h)

The surface the dashboard cannot reach: on call, an alert fires, `@shiba-ai-coworker fix this` in the thread that already holds the stack trace, PR link comes back in that thread.

```
#incidents
  🔴 PagerDuty: 500s on /orders
  └ @prince: retry path. @shiba-ai-coworker fix this
       │  Events API ─▶ POST /api/slack/events
       │  verify HMAC · dedupe event_id · burst-group · ack <3s · waitUntil
       ▼
  resolve repo ◀─ linked URL, else channel→repo map, else ask
  gather context ◀─ conversations.replies + linked issue/PR + review comments
       │
       ▼  CodingOrchestrator DO  name = slack:{team}:{channel}:{thread_ts}
       │  LLM turns thread prose into structured delegate_coding_task
       ▼
  Block Kit card in-thread  [ Approve ] [ Reject ]
       │  click ─▶ /api/slack/interact · signature · SLACK_APPROVERS · still-pending
       ▼
  run ─▶ one message, chat.update'd ─▶ ✅ PR link in thread
```

Three things break on first deploy and none are visible from the happy path: the Access conflict (T12a), retries causing double runs (T12c), and Block Kit buttons being clickable by everyone in the channel (T15).

### T12 · Signed events endpoint, acking under 3 seconds (~3h)

**(a) Access blocks Slack.** Slack's servers cannot complete an Access login — the Request URL verification fails. T7's `SIGNATURE_AUTHENTICATED` exemption handles the code half; the Access application also needs a **Bypass policy** for `/api/slack/*` and `/api/github/webhook`. Both halves, or it silently does not work.

**(b) 3-second ack.** A run takes minutes.

```ts
if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
ctx.waitUntil(handleAppMention(body, env));   // Slack retries anything not acked in 3s
return new Response("", { status: 200 });
```

Requires adding `ctx: ExecutionContext` to the handler at `src/index.ts:75`.

**(c) Retries must not double-run.** Slack resends with `X-Slack-Retry-Num`, including after a *late* 200. One mention would become two containers and two PRs.

```ts
// One mention, one run. event_id is the idempotency key.
if (await orchestrator.hasSeenEvent(body.event_id)) return;
await orchestrator.recordEvent(body.event_id);
```

Bounded ring in the orchestrator DO; Slack stops after three attempts over ~30 min.

**Signature verification** — mirror `verifyGitHubWebhookSignature` in `src/security.ts` and reuse its constant-time compare:

```ts
export async function verifySlackRequest(body, headers, secret, now = Date.now()) {
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!ts || !sig || !secret) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;  // bound replay
  return timingSafeEqual(sig, `v0=${await hmacHex(secret, `v0:${ts}:${body}`)}`);
}
```

**Scopes:** `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `reactions:write`. **Secrets:** `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` — never reach a container.

**Tests:** valid sig passes; tampered fails; 6-minute-old timestamp fails; `url_verification` echoes the challenge; repeated `event_id` is a no-op.

### T13 · Resolve the repo, group bursts, gather and redact context (~3h)

**Repo resolution — never guess.** (1) a GitHub URL in the mention or thread; (2) `SLACK_CHANNEL_REPOS` channel→repo map — this is what makes bare `@shiba-ai-coworker fix this` work in `#incidents`; (3) neither → **reply asking**.

**Burst grouping (borrowed from Capy).** An incident thread fires twenty messages in a minute. Each matched message extends a sliding window (default 10s, bounded 1–300s); the group closes when the window elapses, a different author posts, or it hits 20 messages / 100 KB. **One run per burst, not per message.** Without this, on call is unusable.

**Thread controls (also Capy).** `aside …` excludes a message from processing entirely; `mute` / `unmute` stop replies to non-mention messages. Cheap, and necessary for a bot living in a busy channel.

**Context.** `conversations.replies` for the thread plus any linked issue/PR (`GET /repos/{o}/{r}/issues/{n}`, plus review comments for PRs). The alert text and reviewer comment *are* the task description.

**Bound it** — cap at ~50 messages, `boundTail` each body.

**Redact it — a real leak path.** Thread text flows into the task prompt → container → model. People paste tokens and connection strings into incident threads constantly. Run `redactSecrets` over assembled context, the same guard `opencode-agent.ts:190` applies on the way out.

**Tests:** URL beats channel default; no repo → ask, no run; a 20-message burst yields one run; `aside` messages never reach context; a pasted token is redacted; a 400-message thread is capped.

### T14 · One Slack thread is one orchestrator conversation (~2h)

```ts
// A thread is a conversation. Naming the DO after it gives each thread its own
// history, approval state, and run registry for free.
const stub = await getAgentByName(env.CodingOrchestrator, `slack:${teamId}:${channelId}:${threadTs}`);
```

Approval gating, run registry, concurrency limits, and cancellation all work unchanged — `orchestrator.ts` was written against a name, not `"default"`.

**The prose boundary.** GOAL.md's *"do not scrape arbitrary prose"* governs the **child** boundary (`parseAgentToolInput`), which stays untouched. Human prose → orchestrator LLM → structured `delegate_coding_task`. Prose never crosses into the child. **Leave a comment saying so** — the failure mode is someone later adding a repo-URL regex in `src/slack/events.ts` "to skip a model call", which is exactly what the spec forbids.

**PR by default, warned up front.** The Slack path sets `publishPullRequest: true`. `orchestrator.ts:116-121` throws when `GITHUB_TOKEN` is missing — on this path that lands *after* someone clicked Approve. Check when building the card and render the warning on it.

### T15 · Block Kit approval with an approver allowlist (~3h)

**The security-critical task.** A valid signature proves the request came from Slack. It proves nothing about who clicked. **A Block Kit button in a public channel is clickable by every member** — including people who join later.

```ts
// The signature authenticates Slack, not the human. Empty list = nobody.
const approvers = (env.SLACK_APPROVERS ?? "").split(",").map(s => s.trim()).filter(Boolean);
if (!approvers.includes(payload.user.id)) {
  await respondEphemeral(payload.response_url, "You are not on the approver list.");
  return;
}
```

Unset `SLACK_APPROVERS` means nobody can approve from Slack. **Never default to "anyone in the channel"** — that is the same as having no approval gate, which is the one property this product exists for.

**The button payload is a pointer, not a capability.** Carry `{threadKey, approvalId}`, re-resolve server-side, verify still-pending. Slack messages never expire; someone can click last week's card.

Ack in 3s, then `waitUntil` the dispatch. Update the card via `response_url` (30 min, 5 uses) so buttons visibly resolve to "Approved by @prince".

Render the **exact** structured input that will execute — same discipline as `dashboard/app.tsx:380`. The human approves arguments, not a summary.

**Tests:** non-allowlisted user refused and **no run starts**; empty allowlist refuses everyone; replayed click starts nothing; bad signature → 401; approve resolves the pending call; reject starts no container.

### T16 · Progress and the PR link back in-thread (~2h)

`chat.postMessage` is rate-limited to ~1/sec/channel and T9 emits many events. Post **one** message and `chat.update` it, throttled to ~1 update/5s. Terminal message: PR link, changed-file count, exit status; on failure the real error and exit code (T8 makes that honest). Everything through `safeText`/`redactSecrets` — a Slack channel is often *more* exposed than the dashboard.

### T17 · Update the spec and document the app (~1h)

**`spec/GOAL.md` is now wrong** and it is what the next reader treats as authoritative. Add Slack as a supported entry point; note the dashboard is one surface of two.

New `apps/web/src/content/docs/docs/slack.md`: app manifest and scopes · Request URLs · **the Access bypass policy** (most likely first-deploy failure) · `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN` / `SLACK_APPROVERS` · `SLACK_CHANNEL_REPOS` · the note that workspace admins may need to approve the app.

---

## 10. Phase P4 — Automations (~10h)

Capy's model: 1–20 triggers OR'd together, at most one run per event. This is what turns the product from "a thing you ask" into "a thing that works while you sleep".

### T18 · Trigger engine and storage (~4h)

An `Automations` DO holding `{id, prompt, triggers[], repoUrl, enabled, runAs, lastTriggeredAt, runCount}`.

| Trigger | Source | Notes |
|---|---|---|
| **Schedule** | Cloudflare [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | Five-field cron. Floor of one per 5 min, matching Capy. Coalesce missed occurrences into one run — never a backlog. |
| **GitHub** | existing `/api/github/webhook` | PR opened/pushed/merged, comments, reviews, labels, check runs |
| **Slack** | P3 events endpoint | Reuses T13's burst grouping |
| **Incoming webhook** | `/api/automations/{id}/trigger` | Per-automation secret. **Returned once on create and never again** — say so in the API response and the docs. |
| **On demand** | dashboard button / Slack command | — |

Conditions per trigger: repos, branches, authors, labels (GitHub); channels, authors, text (Slack).

Cron needs a `"triggers": { "crons": [...] }` block in `wrangler.jsonc` and a `scheduled()` export beside `fetch()`.

### T19 · The `run_when` fuzzy gate (~2h)

Exact filters cannot express *"only when it's actually a bug report"*. A `run_when` sentence on a trigger is checked before the run starts.

When `TYPESAFE_API_KEY` is set, TypeSafe System One Noul decides (`noul ≥ 0.8` to run). Otherwise `ORCHESTRATOR_MODEL` (`@cf/meta/llama-3.1-8b-instruct` on Workers AI) answers YES/NO. Both paths **fail closed**.

**Tests:** a matching event passes; a non-matching one records a skip with its reason; a model/HTTP/parse failure **fails closed** (no run) and surfaces, rather than silently firing. TypeSafe noul below 0.8 skips.

### T20 · Automation safety (~4h)

An automation is an approval gate with nobody standing at it. Three controls, all required:

1. **Every automated run still requires approval by default.** The card posts to the configured Slack channel or the dashboard. An automation schedules work; it does not authorize it.
2. **Opt-in unattended mode**, per automation, refused unless `publishPullRequest` is the only mutation and the repo is on an explicit allowlist. A PR is reviewable and revertible; this is the one mutation safe to automate.
3. **A run budget per automation per day.** A cron misconfiguration or a webhook loop otherwise burns tokens until someone notices — and §8 shows tokens, not compute, are the bill. Refuse past the cap and surface it.

Plus a kill switch: disable/enable by id, and a global `AUTOMATIONS_ENABLED` var.

**Tests:** a scheduled run posts an approval card and starts no container until approved; unattended mode refuses a non-allowlisted repo; the daily cap refuses run N+1 and reports why; a disabled automation never fires.

---

## 11. Phase P5 — Bring Your Own Agent and Model (~14h)

**This is the differentiator.** Capy locks you to Capy's agent. Hoplite gives you theirs in the cloud or your own on your laptop, never your own in the cloud. Neither lets a team run *their* harness on *their* account against *their* model. That combination is the entire open-source case — without it, "self-hosted" saves a seat fee and nothing else.

Two axes of lock-in, both hardcoded today:

| Axis | Where | Today |
|---|---|---|
| **Agent harness** (B12) | `Dockerfile`, `buildOpencodeArgv`, `buildOpencodeConfig`, `parseOpencodeEvent` | OpenCode only |
| **Model provider** (B11) | `runtime.ts:295` | `google/*` only |

### T21 · The agent harness seam

`RuntimeAdapter` (`src/runtime.ts`) already abstracts *where* work runs — sandbox vs computer. It does not abstract *what agent* runs. Add a second, narrower seam:

```ts
// What differs between agents is config, argv, and event parsing. Clone,
// collect, diff, and publish are identical and stay in the runtime adapter.
export interface AgentHarness {
  readonly name: "opencode" | "claude-code" | "codex" | "aider";
  /** Hosts this harness must reach. Feeds Sandbox.allowedHosts (T5). */
  readonly egressHosts: string[];
  buildConfig(input: CodingTaskInput): { path: string; contents: string } | null;
  buildArgv(input: CodingTaskInput, workdir: string): string[];
  parseEvent(line: string): ProgressEvent | null;
}
```

`SandboxRuntimeAdapter.runCodingTask` keeps clone → configure → run → collect; only those three calls become harness-dispatched. `collectChanges`, `shellJoin`, the size bounds, and the result envelope are harness-independent and stay exactly as they are.

**Do this refactor with no behavior change first.** Extract the existing OpenCode logic into `src/harness/opencode.ts` behind the interface and confirm all 111 tests still pass before adding a second harness. That green run is the proof the seam is drawn in the right place.

### T22 · Claude Code and Codex adapters

Both are **API-key** harnesses here, not subscription — §3 explains why that path is closed.

| Harness | Egress host | Credential | Headless invocation |
|---|---|---|---|
| OpenCode | `generativelanguage.googleapis.com` | dummy, swapped at egress | `opencode run --format json` (current) |
| Claude Code | `api.anthropic.com` | `ANTHROPIC_API_KEY` via AI Gateway | `--print --output-format stream-json` |
| Codex | `api.openai.com` | `OPENAI_API_KEY` via AI Gateway | `exec` subcommand |

**The credential pattern does not change.** The container gets a dummy key; `outboundByHost` swaps in the real one outside the container. AI Gateway already supports `anthropic` and `openai` as providers, so each harness is one more entry in an existing mechanism — not a new one. The "no real credentials in the container" property survives intact, which is the thing that must not regress.

`allowedHosts` (T5) becomes the union of *the selected harness's* `egressHosts` plus git — not the union of all harnesses. Deny-by-default stays deny-by-default.

**Image size is the real cost.** Three CLIs in one container inflates cold start, and §8 shows you pay that on every run. Prefer one image per harness over one fat image, and measure boot time before deciding. Verify each harness's JSON event format the way T26 pins OpenCode's — a stream format change breaks `parseEvent` silently.

### T23 · Model provider choice (fixes B11)

`runtime.ts:295` hard-rejects anything that is not `google/*`. Replace it with validation against the selected harness's supported providers, and let `CODING_MODEL` carry any `provider/model` that the harness and the gateway both understand.

**Why this outranks every compute optimization in this plan:** §8 shows tokens are 20–40× the Cloudflare bill. A user who can point at Flash-Lite, a cached prompt, or their own OpenRouter account controls the only number that matters. Shaving container seconds saves them four dollars a month.

**Tests:** each harness round-trips its argv and config · an unsupported provider for the selected harness is refused with a clear message · `allowedHosts` reflects only the selected harness · the OpenCode path produces byte-identical output to pre-refactor.

**Adopted method (t3code).** ACP harnesses (Cursor, Grok, and any future ACP agent) plug in through a single shared ACP transport module plus small per-harness support shims — one JSON-RPC session lifecycle for all of them, so a new ACP adapter is config + capability negotiation, not another parser. Credentials live in per-user connected-agent accounts (`harness-accounts`), resolved at run dispatch the same way model connections are — the container still sees only the egress-scoped forwarder, never the raw key.

---

## 12. Phase P6 — Ship (~4h)

### T24 · Honest README and docs

`README.md:5` and `readiness.md` lead with the 503 blocker; after T4 that is false. Rewrite to the shipped state, add Slack, automations, and the supported agent harnesses. **State the `standard-4` ceiling** — 4 vCPU / 12 GiB / 20 GB — so nobody discovers it on a monorepo. Keep "local prototype" until T10 produces evidence, then cite the recorded run.

### T25 · Deploy button and prerequisites

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/princepal9120/shiba)
```

1. Workers Paid (DOs + Containers require it) — §8 for what $5 covers.
2. An AI Gateway with a stored provider key ([BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)) — never enters this repo or the container.
3. **Cloudflare Access on the Worker route, with a bypass for `/api/slack/*` and `/api/github/webhook`.**
4. `GITHUB_TOKEN` — required for PRs, so effectively required for Slack.
5. Optional Slack app — see `slack.md`.

**Then submit to [awesome-cloudflare-selfhosted](https://github.com/theoephraim/awesome-cloudflare-selfhosted)** (466★, audited, three fields in an issue). It requires "a complete, deployable application" — which is why P0 and P2 gate the one distribution channel aimed at exactly this audience.

### T26 · Release hygiene

Pin what can silently break the JSON contract: `opencode-ai@1.18.31` (comment naming `parseOpencodeEvent` as the coupling), `@cloudflare/sandbox@0.12.9` (must match the base image tag). Note in `contributing.md`: bumping either requires re-running T10. **Add the model id to this list** — B3 is the same class of failure.

---

## 13. Verification

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src dashboard test
npm test             # vitest run — baseline 269/269 across 21 files (rev 4)
npm run build        # dashboard + Astro docs + link check
npx wrangler deploy --dry-run
```

**Known limitation (from VERIFICATION.md):** the dry run fails without a local Docker CLI because it packages the container image. Environment gap, not a code defect. **T1–T3 are exactly what a dry run catches** — run it on a machine with Docker before P2.

**Slack and automations cannot be verified by unit tests alone.** Signature checks, dedupe, allowlists, and gates are testable; the Request URL handshake, the Access bypass, the 3-second ack, and cron delivery are not. Each of P3–P4 carries live acceptance criteria in §14.

---

## 14. Implementation Order

| Phase | Tasks | Blocking? | Effort |
|---|---|---|---|
| **P0** Deployability | T1 · T2 · T3 · T4 | **Yes — nothing deploys or runs** | ~3h |
| **P1** Security | T5 · T6 · T7 · T8 | Yes, before any exposure beyond localhost | ~5h |
| **P2** Proof | T9 · T10 · T11 | Yes, before claiming it works | ~5h |
| **P3** Slack | T12 · T13 · T14 · T15 · T16 · T17 | No — but it is the surface you asked for | ~14h |
| **P4** Automations | T18 · T19 · T20 | No | ~10h |
| **P5** Bring your own agent | T21 · T22 · T23 | No — but it is the OSS differentiator | ~14h |
| **P6** Ship | T24 · T25 · T26 | No | ~4h |

**Critical path:** T4 → T1 → T2 → T3 → T10 → T12 → T15. T4 first because it is what makes runs fail today. T10 before any Slack work — debugging a Slack integration on an unproven run path means debugging two things at once.

T5–T8 are independent of each other. Within P3, T12 gates everything; T13/T14 are independent; T15 needs T14; T16 needs T15. P4's Slack trigger reuses T13 rather than modifying it, so it does not disturb the Slack work.

**P5 is independent of P3 and P4 and could move earlier.** It only touches `src/runtime.ts`, `src/harness/`, and the Dockerfile. Pull it forward if provider cost is the thing blocking adoption — §8 says it probably is. The one ordering constraint is that T21's no-behavior-change refactor wants the 111-test baseline intact, so run it before P4 adds tests, not after.

**Write T7's `SIGNATURE_AUTHENTICATED` exemption when you build T7, not when you build T12.** Access and Slack conflict by construction; knowing Slack is coming saves a broken deploy.

---

## 15. Success Criteria

**P0** — `new_sqlite_classes` + `instance_type` + a live model id · zero references to `providerBaseUrl`/`WORKER_ORIGIN`/`CF_ACCOUNT_ID`/`handleProvider` · typecheck, lint, tests green · `deploy --dry-run` completes with Docker

**P1** — `allowedHosts` set, non-listed host refused by test · out-of-scope repo returns 403 with no auth header · unauthenticated `/api/runs` → 401 while `/api/slack/*` stays open · an `error` envelope never reads `completed`

**P2 — the one that matters** — `VERIFICATION.md` records a dated live run: submit → approve → clone/code/collect → diff matches reality · rejection provably starts no container (container metrics, not the UI) · a failing task reports its real exit code · a PR shows a deleted file as deleted · **peak memory measured**, `basic` vs `standard-1` decided on data

**P3 — verified live in a real workspace** — Request URL verification succeeds *with Access enabled* · `@shiba-ai-coworker fix this` posts a card in-thread · the card shows the exact arguments that will execute · a non-`SLACK_APPROVERS` user clicking Approve is refused and **no container starts** · an approver's click runs it and progress updates in-thread · PR link lands in the same thread · a second click on a resolved card starts nothing · a forced retry (duplicate `event_id`) produces **one** run · a 20-message burst produces **one** run · `aside` never reaches context · a pasted token appears in no Slack message or task input

**P4** — a cron automation fires on schedule and posts an approval card · **no container starts before approval** · `run_when` skips a non-matching event and records why · a model failure in the gate fails closed · unattended mode refuses a non-allowlisted repo · the daily budget refuses run N+1 with a reason · a disabled automation never fires

**P5** — the OpenCode path produces byte-identical output after the T21 refactor, with all 111 tests green before any second harness lands · a Claude Code run completes end to end with the key never present in the container · `allowedHosts` contains only the selected harness's hosts · an unsupported provider is refused with a clear message · cold-start time measured per harness image

**P6** — README, readiness.md, and GOAL.md describe the shipped system with P2/P3 runs cited · the `standard-4` ceiling stated · deploy button + ordered prerequisites incl. the Access bypass · versions and the model id pinned with couplings documented · submitted to awesome-cloudflare-selfhosted

---

## 16. Risks, Assumptions, Failure Conditions

**Assumptions that could be wrong**

- **`standard-1` is enough.** Inferred, not measured. T10 decides. Note the cost inversion: `basic` gives 4× the free-tier runs, so this is a billing decision as much as a capability one.
- **Editing migration `v1` in place is safe.** Only if never deployed. Otherwise use `v2`.
- **`interceptHttps` + `outboundByHost` keeps working.** Documented and shipped, but the entire "no credentials in the container" claim rests on this one mechanism. Pin the SDK (T26) and treat its upgrades as security-relevant.
- **OpenCode's JSON event shape is stable.** `parseOpencodeEvent` couples to it directly.
- **The orchestrator LLM extracts repo and task reliably from thread prose.** `@cf/meta/llama-3.1-8b-instruct` is small and T14 asks it to parse messy incident threads. The approval card is the safety net — the human sees exact arguments. But a card wrong every third time is a product nobody trusts. If T10/P3 acceptance shows poor extraction, **raise `ORCHESTRATOR_MODEL` before adding parsing heuristics** — a bigger model is the cheaper fix, and a regex here is what GOAL.md forbids.
- **The `agents` SDK uses WebSocket Hibernation.** Unverified. If it does not, idle dashboard tabs bill DO duration continuously (§8).

**Failure conditions**

| Condition | What changes |
|---|---|
| A second human uses one deployment | Single-tenant breaks. Slack makes this pressing — a workspace is inherently multi-person, and `SLACK_APPROVERS` is an authorization list bolted onto a single-tenant system. It holds for one team, one account. Not two teams. |
| Private repos need clone-time auth | T6's path scoping is necessary but insufficient; you need the `leo-ars` per-run opaque token and the token store GOAL.md currently excludes. |
| PRs must open as the requesting human | Needs GitHub OAuth impersonation. Worth wanting: a PR opened as the requester makes GitHub's own "no self-approval" rule enforce independent review. With one shared `GITHUB_TOKEN` every PR has the same author and that protection is absent — a branch-protection rule is the weaker substitute. |
| Model costs become the complaint | They already are (§8: 20–40× compute). **B11** is the answer. Prompt caching is the second lever. |
| A provider retires a model | B3 will recur. T26's pinning list and T3's startup assertion are the mitigation. |
| Runs regularly exceed `OPENCODE_TIMEOUT_MS` (15 min) | One-shot delegation is the wrong shape; you need resumable runs — Workflows or checkpointing, a genuine architecture change. Cloudbox already solved this with stop/resume/fork. Slack makes it more likely, because an on-call request arrives with less scoping than a dashboard one. |
| A harness changes its JSON stream format | `parseEvent` breaks silently for that harness only — the run appears to hang rather than fail. Pin every harness CLI version (T26) and treat format changes as breaking. This risk multiplies with each harness added, which is the real ongoing cost of P5. |
| Users need machines bigger than `standard-4` | Platform ceiling. No workaround on Cloudflare. This is the honest limit of the whole approach. |
| Codra adds "fix" to "review" | Your closest active competitor lands directly on this product with a year's head start. Dropping the review agent (§4) widens the gap on that flank; the answer is shipping P3 and P5, where neither Capy nor Hoplite can follow. |

**Standing risk:** mocked tests cannot establish any of this works in the cloud. 111 green tests and a clean dry run are necessary, not sufficient. Until T10 and the P3–P5 acceptance lists are dated in `VERIFICATION.md`, the honest status stays "local prototype" — exactly as `readiness.md` already says.

---

## 17. Phase P7 — Roomote Parity (rev 9)

**Added:** 2026-09-27. **Benchmark:** [Roomote](https://github.com/RooCodeInc/Roomote) — a self-hostable cloud coding agent (Slack/Teams/Telegram/Discord/Web → ephemeral sandbox → clone → code → test → screenshot → PR). Source-available, FCL-1.0.

**One correction before anything else:** Roomote is **not** a VS Code remote-control extension. That is Roo Code's Cline extension. Roomote is a *server-side* cloud agent — the same category as Capy/Hoplite, which is what §3 already benchmarks. The port is therefore a feature-parity exercise against a peer, not an integration of a plugin.

**What this phase is not:** a rewrite. As of rev 8 the repo already implements the large majority of Roomote's spine. The work below is the honest delta.

### 17.1 Parity baseline — what already exists

| Roomote capability | ai-intern status | Evidence |
|---|---|---|
| Task from Slack / Telegram / Discord / email | **Done** | `slack-routes.ts`, `telegram.ts`, `chat-lane.ts` (Discord), `email-handler.ts` |
| Web dashboard | **Ahead** | `apps/frontend/src/components/` — Approvals, Agents, Missions, Automations, Memory, Inbox, Audit, Gates, VMInspector |
| Ephemeral sandbox per task | **Ahead** | `sandbox.ts`, `sandbox/lifecycle.ts` — per-run `allowedHosts`, TLS interception CA, destroy-on-finish |
| BYOK models | **Ahead** | `model-connections.ts` + `model-config-do.ts` + `model-policy.ts` (frozen `ApprovedRoute`) |
| Multi-harness CLIs | **Done / in progress** | `harness/index.ts` — opencode, claude-code, codex, cursor, devin, grok + `acp.ts` transport |
| Approval gate before execution | **Ahead** | Sacred invariant (§15 P1) |
| Automations (cron/webhook/event) | **Ahead** | `automations.ts`, `automations-do.ts`, TypeSafe `run_when` |
| MCP server | **Partial** | `mcp-gateway.ts` — bearer-only, no OAuth |
| Memory / mailbox | **Done** | `memory-do.ts`, `mailbox-do.ts` |
| Screenshot + live preview in PR | **Partial** | preview proxied at `index.ts:1093-1099`; **screenshot capture missing** |
| OAuth MCP (its headline feature) | **Missing** | `grep -rn oauth apps/backend/src/{mcp-gateway,index}.ts` → empty |
| Interactive web chat + mid-run steering | **Missing** | `apps/frontend/src/routes/` has only `__root.tsx`, `app.tsx` |
| GitLab / Gitea / Bitbucket / ADO | **Missing** | `github.ts` only |
| Multi-user accounts | **Missing** | single-tenant by design (§4) |
| Teams lane | **Missing** | Slack/Telegram/Discord/email only |
| Alternate sandboxes (Modal/E2B/Daytona/Blaxel) | **Deliberately not** | Cloudflare-native is the thesis; `runtime.ts` adapter seam is the only concession |

### 17.2 W0 — Unblock the spec (do this first, ~1h)

**T27 · Reconcile `spec/GOAL.md` with the monorepo.** `GOAL.md` still says *"Do not add D1, KV, Queues, R2, Workflows, Hono, or a monorepo."* The repo is now `apps/{backend,frontend,web}` + turbo + alchemy (`package.json`, `pnpm-workspace.yaml`, `alchemy.run.ts`). The spec the next reader trusts is contradicted by the tree.

Two honest options — pick one explicitly, do not leave it implicit:
- **(a) Amend `GOAL.md`** to accept the monorepo and record *why* it became necessary (backend/frontend/docs separation, turbo caching). Then enumerate which of the other forbidden primitives are now in use and justify each.
- **(b) Revert the monorepo.** Not recommended — it would undo shipped, working work to satisfy prose.

**T27 gates T28–T36.** Every task below is written against the monorepo layout; amending the spec first stops the next reader from re-litigating it.

**T28 · Confirm G10/G11 are closed, then re-audit `VERIFICATION_PLAN.md`.** `VERIFICATION_PLAN.md:26-27` records G10 (all landing images gitignored) and G11 (duplicate configs) as open, but both are now **fixed** in the tree — `.gitignore:3-6` negates `public/` and `apps/web/public/**`, and `git ls-tree -r HEAD -- apps/web/public/assets` returns 22 tracked files. The findings are stale, not the code.

So T28 is not a fix, it is a **re-audit**: walk the whole G1–G11 table, re-run each check, and mark resolved ones resolved with the command that proves it. That table has already misled one reader (§4 records the Slack precedent, where a stale cut survived a full rev). **Do not add features on top of an audit nobody has re-run.**

### 17.3 W1 — OAuth MCP (~8h) · *the unblocking one*

**T29 · OAuth 2.1 authorization server on `/mcp`.** Today `mcp-gateway.ts` + `index.ts:76` accept only a static bearer `agent-token`, and `index.ts:90` states it explicitly. Roomote's headline capability is *"connect to Claude Code, Codex, or Cursor through its OAuth MCP server."* Without this, no third-party MCP client can connect.

- Discovery: `/.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource`.
- Authorization Code + PKCE (S256), public clients, no client secret.
- Tokens: short-lived access, rotating refresh, hashed at rest in the `model-config-do`-style DO.
- **Security invariants (non-negotiable, per `CLAUDE.md`):** the OAuth path must not weaken the approval gate — every `registerTool` dispatch still goes `requireScope` → handler → `audit`; the `MCP_PRINCIPAL_HEADER` worker-injection defense (strip client copies) still applies; secrets never in a URL, a log, or a UI response; grant issuance is rate-limited and audited.
- Migration: existing bearer tokens keep working (they are the documented path today) — OAuth is additive.

**Why first:** it is the only item that makes the repo usable *from* other agents, and it reuses `agent-tokens.ts` rather than adding a new auth model.

### 17.4 W2 — Web chat + live steering (~14h) · *the real UX delta*

**T30 · Chat route + session conversation.** `apps/frontend/src/routes/` contains only `__root.tsx` and `app.tsx` — there is no chat surface. Roomote's core loop is conversational: send a follow-up into a *live* run and watch it steer.

- New `/chat` route over the existing `ai-chat` stream; reuse `CodingOrchestrator` rather than a parallel agent.
- Follow-up turns append to the same conversation; `chat-lane.ts` already establishes the "one conversation per chat/channel" naming pattern — mirror it for web sessions.

**T31 · Mid-run steering with the approval gate intact.** A follow-up that changes scope must **re-freeze the approved input and re-request approval**, exactly as `model-policy.ts` does for routes. Steering must never become a bypass around T7/T12 approval. This is the single highest-risk task in the whole phase; write the invariant test first.

**T32 · Session list + resume in the UI.** `SessionsSidebar.tsx` exists; it needs real session persistence, not a static view.

### 17.5 W3 — Screenshot + live preview in the PR (~6h)

**T33 · Capture and attach.** Run the app in-sandbox, screenshot, upload, attach to the PR body and the run record. **Preview plumbing already exists** — `index.ts:1093-1099` wires `proxyToSandbox` into the request path, so this is capture and presentation, not architecture. Screenshot is the genuinely missing half. Cheapest real parity win in the plan; do it after W2 because screenshots are most valuable when attached to a steered run.

**Open question, answer during T33:** Cloudflare Sandbox containers have no browser installed, and the image deliberately keeps `registry.npmjs.org` off the egress allowlist. Capture therefore needs *either* a pinned headless-browser layer in the image (image size vs. cold-start cost — the §8 concern) *or* an external capture service. **Decide with data, do not guess.**

### 17.6 W4 — Repo providers (~8h)

**T34 · Provider abstraction behind `github.ts`.** GitLab, Gitea, Bitbucket Cloud, Azure DevOps. The approval gate, run model, and harness seam are already provider-agnostic, so this is a provider interface plus implementations — but each new provider is a **new credential egress path**, which is the §16 risk that already bit once (B6). Sequence: GitLab (largest demand) → Gitea/Bitbucket (self-hosted, same auth shape) → ADO (different auth entirely, likely its own task). Per-provider token scoping is mandatory and separately tested — the T6 pattern generalizes.

### 17.7 W5 — Multi-user accounts (~12h) · *product decision, not just code*

**T35 · Registration, per-user repos, ownership.** §4 cut multi-tenancy citing `GOAL.md`: *"Each installation is single-tenant and account-owned."* Roomote supports 10 users self-hosted and sells licensing above that. `waitlist-do.ts` gives a partial user model to build on.

**This is a spec change, not a feature.** It reverses an explicit §4 cut and a `GOAL.md` line, and it is the item most likely to be *cut again* by a future reader. Whatever the decision, it belongs in `PLAN.md` §4 and `GOAL.md` **before** code — the same lesson §4 already records about Slack.

### 17.8 W6 — Teams lane (~4h) · *lowest value, do last or not at all*

**T36 · Teams bot.** Another lane in `chat-lane.ts`: OAuth bot registration, message handling, approval cards, allowlisted approvers. Lowest value in this plan — it is surface area that deepens nothing, against `GOAL.md`'s *"keep the smallest working architecture."* **Recommendation: cut.** If built, it ships only after W1–W3 are proven live.

### 17.9 Order and dependencies

| Wave | Tasks | Blocks | Effort | Verdict |
|---|---|---|---|---|
| **W0** spec | T27 · T28 | **all** | ~1h | **Do first** |
| **W1** OAuth MCP | T29 | — | ~8h | **Do** — the unblocker |
| **W2** web chat + steering | T30 · T31 · T32 | — | ~14h | **Do** — the real delta |
| **W3** screenshot/preview | T33 | benefits from W2 | ~6h | **Do** — cheapest win |
| **W4** multi-repo | T34 | — | ~8h | Optional |
| **W5** multi-user | T35 | — | ~12h | **Spec decision first** |
| **W6** Teams | T36 | — | ~4h | **Recommend cut** |

**Critical path:** T27 → T29 → T30 → T31. T28 is parallel. T33–T34 are independent of W1/W2 and can be pulled forward.

**Recommended scope: W0–W3 only** (~43h). That is the honest "Roomote parity" for a Cloudflare-native single-tenant deployment. W4 is cheap polish; W5 is a product decision that changes who your customer is; W6 is a channel.

**Standing constraint, unchanged:** W1–W6 are all *in front of* the same wall as everything else. Until T10's dated live acceptance is in `VERIFICATION.md`, none of this is proven in the cloud. **A wave does not ship because its unit tests pass** — that is the §16 standing risk, and it is why W0 exists before W1.

### 17.10 Success criteria

**W0** — `GOAL.md` no longer contradicts the tree; `git ls-tree -r HEAD -- apps/web/public` returns the assets a fresh clone needs; no duplicate config files.
**W1** — an OAuth client completes code+PKCE against `/mcp`; discovery documents are served; refresh rotates; a revoked token is refused; **the approval gate and `audit` path are provably unchanged for OAuth-issued principals**; a test proves a client-supplied `MCP_PRINCIPAL_HEADER` is still stripped.
**W2** — a follow-up steers a live run; a scope-changing follow-up **re-requests approval and starts no container without it** (proven by container metrics, not UI); sessions survive reload.
**W3** — a PR carries a screenshot and a working preview URL; the capture decision (§17.5) is written down with its cost measurement.
**W4** — each provider's token is scoped to one repo and a test proves cross-repo access is refused, mirroring T6.

---

## References

**Roomote** (observed 2026-09-27) — [RooCodeInc/Roomote](https://github.com/RooCodeInc/Roomote) · [docs.roomote.dev](https://docs.roomote.dev) · [MCP integration guide](https://docs.roomote.dev/integrations/roomote-mcp) · [SELF_HOSTING.md](https://github.com/RooCodeInc/Roomote/blob/main/SELF_HOSTING.md). Parity claims above are from the public README; sandboxes/providers/channels are README-advertised, not independently verified against a running deployment. Roomote is FCL-1.0 (free ≤10 users, licensed above) — **read the license before copying any implementation.**

**Cloudflare** — [Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) · [credential injection changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/) · [Sandbox get-started](https://developers.cloudflare.com/sandbox/get-started/) · [Sandbox options](https://developers.cloudflare.com/sandbox/configuration/sandbox-options/) · [Containers limits](https://developers.cloudflare.com/containers/platform/limits/) · [Containers pricing](https://developers.cloudflare.com/containers/pricing/) · [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [Wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/) · [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) · [Think tools and approval](https://developers.cloudflare.com/agents/harnesses/think/tools/) · [AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)

**Slack** (observed 2026-09-17) — [`app_mention`](https://docs.slack.dev/reference/events/app_mention) · [`url_verification`](https://docs.slack.dev/reference/events/url_verification) · [verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack) · [`block_actions`](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload) · [Block Kit](https://docs.slack.dev/reference/block-kit)

**Models** — [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) (2.0 Flash **shut down 2026-06-01**; 3.8 Flash rates **double 2027-01-01**) · [Claude Code legal](https://code.claude.com/docs/en/legal-and-compliance) (no third-party routing of Pro/Max credentials)

**Competitors** — [Capy docs](https://docs.capy.ai/welcome) · [Hoplite docs](https://hoplite.sh/docs) · [vibesdk](https://github.com/cloudflare/vibesdk) · [weft](https://github.com/jonesphillip/weft) · [cloudsail](https://github.com/nkzw-tech/cloudsail) · [codra](https://github.com/devarshishimpi/codra) · [cloudbox](https://cloudbox.coey.dev/docs) · [leo-ars/cloudflare-sandbox-coding-agent](https://github.com/leo-ars/cloudflare-sandbox-coding-agent) · [awesome-cloudflare-selfhosted](https://github.com/theoephraim/awesome-cloudflare-selfhosted)

**Local** — `spec/GOAL.md` (**stale as of rev 2 — T17**) · `apps/web/src/content/docs/docs/readiness.md`
