# Architecture — shiba

**Purpose:** one high-level map of how the system is put together, so a new
reader can navigate it without reading 80 files. Derived from the deployed
configuration (`apps/backend/wrangler.jsonc`, `alchemy.run.ts`) and the Worker
entry (`apps/backend/src/index.ts`) — as-built, not aspirational.

**Status:** see `PLAN.md` §2.0 for what is verified. Plan and gaps live in
`PLAN.md`; evidence in `VERIFICATION.md`.

**Companions:** `spec/GOAL.md` (product contract — *currently contradicted by
the tree*, see `PLAN.md` §17.2 T27) · `design.md` (visual design system, not
this) · `PLAN.md` §17 (parity roadmap).

---

## 1. The one-paragraph version

A single Cloudflare Worker is both the **API** and the **static host** for the
React dashboard. Nine **Durable Objects** hold all state — the orchestrator
conversation, the coding sub-agent, per-run sandbox control, automations,
mailbox, memory, waitlist, and model config. The MCP gateway is stateless
(`createMcpHandler` per request), not a DO. Work happens in an
**ephemeral Sandbox container** (one per run, destroyed at the end) that clones
a GitHub repo and executes one of six agent binaries. Nothing starts until a human
approves it, and the container's outbound network is allowlisted per run.

---

## 2. Topology

```
                        ┌───────────── ingress (one Worker) ─────────────┐
   Dashboard  ────────► │  /api/*  authenticated (Cloudflare Access)     │
   Slack / Discord  ──► │  /api/slack/*, /api/discord/*  signature-verified│
   Telegram  ─────────► │  /api/telegram/*  header-secret                 │
   Email  ───────────► │  /api/emails, /api/drafts  provider-verified    │
   Cron (5 min)  ────► │  automations trigger sweep                      │
   GitHub  ──────────► │  /api/github/webhook  signature-verified        │
   MCP clients  ─────► │  /mcp  bearer token  (OAuth: planned, T29)      │
   Agents (WS)  ─────► │  /agents/*, /internal/*                         │
                        └────────────────────┬───────────────────────────┘
                                             ▼
   ┌──────────────────── Durable Objects (all state) ───────────────────────┐
   │  CodingOrchestrator  Think agent — plans, delegates, NEVER edits       │
   │  OpenCodeAgent       AIChatAgent — sandbox-side coding sub-agent       │
   │  Sandbox             container lifecycle per run                       │
   │  Automations         cron/webhook/event triggers, budget, kill switch  │
   │  Mailbox             inbound email       Memory  banked facts          │
   │  ModelConfig         model conns         Waitlist  signups             │
   └──────────────────────────────┬─────────────────────────────────────────┘
                                          ▼  delegate_coding_task (approved)
   ┌─────────────────── Sandbox container — ephemeral, 1 per run ──────────┐
   │  clone (scoped token) → run ONE harness CLI → collect diff → push → PR│
   │  egress: deny-by-default allowlist = that harness's provider host + git│
   │  image pins 6 CLIs; real keys injected at AI Gateway egress, not here  │
   └───────────────────────────────────────────────────────────────────────┘
                                          ▼
   AI Gateway (BYOK) ← Workers AI (planning) ← TypeSafe (run_when)
   GitHub API (PR)   ← R2 (attachments) ← D1 (audit) ← KV (agent tokens)
```


---

## 3. Layer breakdown

| Layer | Lives in | Responsibility |
|---|---|---|
| **Ingress** | `index.ts` (router), `slack-routes.ts`, `public-routes.ts`, `sandbox-routes.ts` | Auth per surface, then dispatch. Auth is **per-surface by design** — see §5. |
| **Orchestration** | `agents/orchestrator.ts`, `automation-runner.ts` | Plans, exposes `delegate_coding_task`, queues approvals. Never touches a repo. |
| **Execution** | `agents/opencode-agent.ts`, `harness/*`, `sandbox.ts`, `sandbox/lifecycle.ts` | Clone → exec harness → collect. Exactly one harness per run. |
| **Egress control** | `egress.ts`, `sandbox.ts` (`allowedHosts`) | Deny-by-default; per-harness host list; TLS interception; scoped GitHub token. |
| **State** | the nine DO classes | All durable state. No other store is authoritative. |
| **Presentation** | `apps/frontend` (dashboard), `apps/web` (docs/marketing) | React dashboard; Astro docs. Both served via the Worker's `ASSETS` binding. |
| **Deploy** | `alchemy.run.ts` (primary), `wrangler.jsonc` (rollback) | Both declare the same stack; wrangler remains a working rollback path. |

**Three deployment facts that matter:**

1. **Two deploy paths, one stack.** `alchemy.run.ts` and `wrangler.jsonc`
   declare identical bindings. Live stages pin resource names so the first
   alchemy deploy *adopts* wrangler-managed resources in place rather than
   replacing them.
2. **Static assets come from the Worker.** One host serves API and UI; there is
   no second deployment target.
3. **Secrets never enter the container.** The container gets a dummy key; real
   provider credentials are injected at AI Gateway egress only.

---

## 4. Durable Objects — the state map

| DO | Owns | Migration |
|---|---|---|
| `CodingOrchestrator` | one conversation per repo/project; approval state; `delegate_coding_task` | v1 |
| `OpenCodeAgent` | the sandbox-side coding agent session | v1 |
| `Sandbox` | container lifecycle for one run | v1 |
| `Automations` | automation records, dedupe, daily budget | v2 |
| `Mailbox` | inbound email | v3 |
| `Memory` | banked facts (+ Vectorize embeddings) | v5 |
| `Waitlist` | signups | v6 |
| `ModelConfig` | model connections + purpose policy | v7 |
| `LocalDispatch` | local-runtime dispatch mailbox: pending/claimed/settled run envelopes | v9 |

Migration tag **v4** created `McpGateway`. T29a moved the MCP gateway to a
stateless `createMcpHandler` server (`mcp-gateway.ts` builds an SDK v2
`McpServer` per request — same tools, scopes and D1 audit trail, no DO). The
append-only **v8** migration deletes the now-unused class and namespace.

**Supporting stores** (not DOs): **R2** `ATTACHMENTS` (email bodies >256KB) ·
**KV** `AGENT_TOKENS` (bearer tokens, keyed `tok_<sha256(raw)>`) · **D1**
`AGENT_AUDIT` (MCP call audit) · **Vectorize** `MEMORY_VECTORS` (768-dim recall).

---

## 5. The security model — the part that must not drift

This is the architecture's real contract. Five invariants, each with an
existing enforcement point:

1. **Approval before execution.** No sandbox starts without a human approving
   the *frozen* input. The `ApprovedRoute` pattern freezes what was approved and
   revalidates at dispatch.
2. **Deny-by-default egress.** `allowedHosts` is set per run to the selected
   harness's provider host + git — **never the union across harnesses**.
3. **Scoped git credentials.** `github.com` defaults to *refusal*;
   `approveRepoScope("/owner/repo")` installs a repo-scoped forwarder before the
   clone, so repo code cannot reach any other repo the token can see.
4. **Secrets stay out of the container, logs, URLs, and UI.** Dummy key inside
   the container; automation webhooks are header-only; no secret in a query
   string or an error message.
5. **Per-surface authentication.** Access-gated APIs, signature-verified Slack
   and GitHub, header-secret Telegram/Discord/email, bearer-token `/mcp`, and a
   narrow explicit bypass list. A new ingress surface must add its own
   mechanism, never inherit one.

**Why this is architecture and not a feature:** every parity feature in
`PLAN.md` §17 that touches ingress — OAuth on `/mcp`, Teams, more repo
providers — is a chance to weaken one of these. That is why §17.3 lists the
invariants as non-negotiable acceptance criteria, not as context.

---

## 6. Request lifecycle — one run, end to end

```
1  ingress    dashboard / Slack / cron / webhook → auth per surface
2  intent     orchestrator plans; prose → structured delegate_coding_task
3  gate       approval card with the exact frozen arguments; human approves
              (automations: approval by default, narrow opt-in unattended)
4  dispatch   approved input frozen; route revalidated at dispatch
5  sandbox    ephemeral container: clone (scoped) → run the harness CLI
6  egress     AI Gateway swaps the dummy key for the real provider key
7  collect    diff, exit code, structured result envelope (error ≠ completed)
8  publish    branch + PR; optional screenshot (planned, T33)
9  cleanup    container destroyed; short sleep tail; result + receipts recorded
```

Steps **3** and **6** are the load-bearing ones. Everything else is
replaceable — which is why resumable runs (`PLAN.md` §4) and the parity waves
can be built without touching them.

**Local lane** (`runtime:"local"`, dark unless `SHIBA_LOCAL_RUNTIME=1`): the
same intake → gate → approve → dispatch path, but step 5's container is
replaced by the operator's own machine. `LocalRuntimeAdapter` posts a
schema-checked envelope (`localRunEnvelopeSchema`) to the `LocalDispatch` DO;
the operator-run daemon (`scripts/shiba-local-daemon.mjs`) polls
`POST /api/local/claim` + `POST /api/local/result` behind a `LOCAL_ADAPTER_TOKEN`
bearer, executes under the same exec/setup allowlists the envelope carries,
returns receipts + diff, and the Worker runs the identical `harness.verify`
verdict and PR publish. Chat intake is provably impossible: `queueSlackRun`
refuses `runtime:"local"` unless the request carries the `X-Shiba-Intake:
dashboard` voucher that only `handleRuns` stamps (inbound copies are deleted
first). Capability opt-in: `opencode`, `claude-code`, `codex` declare
`supportedRuntimes:["sandbox","local"]`; every other harness refuses.
Provider credentials stay local — the dummy key is dropped from the envelope
and config bodies reference `${OPENCODE_API_KEY}`-style placeholders resolved
on the operator side.

---

## 7. Harnesses

One image ships six agent binaries; a run selects exactly one.

| Harness | Binary | Default model | Credential |
|---|---|---|---|
| `opencode` | `opencode` | `google/gemini-3.5-flash-lite` | AI Gateway BYOK |
| `claude-code` | `claude` | `anthropic/claude-sonnet-4-6` | AI Gateway BYOK |
| `claude-subscription` (opt-in: `SHIBA_CLAUDE_SUBSCRIPTION=1`) | `claude` | `anthropic-subscription/claude-sonnet-4-6` | `CLAUDE_SUBSCRIPTION_TOKEN` secret on a dedicated egress branch — bypasses AI Gateway |
| `codex` | `codex` | `openai/gpt-5.3-codex` | AI Gateway BYOK |
| `codex-subscription` (opt-in: `SHIBA_CODEX_SUBSCRIPTION=1`) | `codex` | `openai-subscription/gpt-5.3-codex` | `CODEX_SUBSCRIPTION_AUTH_JSON` secret (auth.json contents) on a dedicated chatgpt.com egress branch — bypasses AI Gateway; container CODEX_HOME gets a stub auth.json in a per-account shadow overlay |
| `antigravity-subscription` (opt-in: `SHIBA_ANTIGRAVITY_SUBSCRIPTION=1`) | `agy` (ACP server, pinned in image) | `google-subscription/gemini-3-pro` | In-container OAuth — no Worker credential. `POST /api/auth/antigravity-subscription/begin` boots an auth sandbox that prints the Google URL; the operator signs in and pastes the dead `127.0.0.1` redirect into `POST /api/antigravity/callback`, which forwards it to the container listener. Tokens live only in the per-account profile under `/root/.shiba/antigravity/` |
| `devin` | `devin` | `devin/swe-2` | `DEVIN_API_KEY` secret |
| `grok` | `grok` | `xai/grok-4.6` (medium reasoning) | AI Gateway BYOK |

Defaults live in `harness/index.ts` (`HARNESS_DEFAULT_MODELS`) and are
overridable per deploy (`CODING_MODEL`, `CLAUDE_CODE_MODEL`, `CODEX_MODEL`,
`DEVIN_MODEL`, `GROK_MODEL`) and per run via the delegate tool's
`codingModel` input. They are defaults, **not
availability guarantees** — model ids retire, and `coding-model.ts` asserts the
configured model is not on the retired deny-list at first request.

Versions are pinned in the Dockerfile and mirrored in `harness/catalog.ts` —
**bump both** (T26). Selection is per run, defaulting to the deploy-time
`AGENT_HARNESS`; an invalid harness throws *before* approval, never as an exec
error inside the container. Grok runs its verified headless print mode
(`--single` + `streaming-json`) pinned to the `api.x.ai` forwarder via
`GROK_MODELS_BASE_URL`; the shared ACP transport was tried and dropped.
Cursor stays a remote-executor connection — its API-key→token exchange
stores tokens in the container and cannot hold the dummy-key invariant.

**Caveat carried from `PLAN.md` §2.0:** only OpenCode has completed a live run.
The other four are unit-tested against their documented stream formats.

---

## 8. How this evolves

New capability lands in one of four places, and the choice is not arbitrary:

| If the change is… | It belongs in | Because |
|---|---|---|
| A new way in (Slack, Teams, a webhook) | ingress + a lane module | every surface authenticates independently |
| A new agent CLI | `harness/` + Dockerfile + catalog | one image, per-run selection, per-harness egress |
| A new stateful thing | a new DO + a migration tag | DOs are the only authoritative state |
| A new model/provider | `model-connections` / AI Gateway | credentials stay at the egress boundary |

**The cost of adding harnesses is real and ongoing:** each one multiplies the
"a CLI changed its stream format" risk (`PLAN.md` §16). Treat format changes as
breaking, and pin versions. That is the real marginal cost of the
bring-your-own-agent differentiator, not the first adapter.

---

## 9. Known architectural gaps

Not bugs — deliberate or inherited, recorded so they are not rediscovered:

- **`/mcp` is bearer-only.** No OAuth discovery, so third-party MCP clients
  cannot connect. It gates other parity work (`PLAN.md` §17.3, T29).
- **No interactive web chat.** The dashboard submits a task and polls; there is
  no conversational steering surface (§17.4).
- **GitHub is the only repo provider — by decision.** The approval gate is
  already provider-agnostic, so adding one later is a provider layer, not a
  redesign. Deferred until GitHub itself is proven live (`PLAN.md` §17.6).
- **Single-tenant by contract.** Reversing that is a *product* decision that
  belongs in `spec/GOAL.md` before any code (§17.7).
- **The spec contradicts the tree.** `spec/GOAL.md` forbids a monorepo; the
  repo is `apps/*` + turbo + alchemy. First thing to fix (§17.2, T27) —
  documentation debt with real cost.
- **No dated live acceptance.** Every capability above is verified by unit
  tests and a dry run, not a recorded cloud run. Until T10's acceptance — and
  the GitHub-specific T37–T39 — are in `VERIFICATION.md`, the honest status
  stays "local prototype" (§17.9).

---

## 10. Where to start reading the code

| To understand… | Read |
|---|---|
| the request pipeline | `apps/backend/src/index.ts` → `agents/orchestrator.ts` |
| how a run executes | `agents/opencode-agent.ts` → `harness/index.ts` → `harness/types.ts` |
| the security boundary | `egress.ts`, `sandbox.ts`, `security.ts` |
| state and persistence | the eight `*-do.ts` / agent classes in §4 |
| every ingress surface | `slack-routes.ts`, `chat-lane.ts`, `telegram.ts`, `discord.ts`, `email-handler.ts` |
| what is planned and why | `PLAN.md` (§17 for parity roadmap, §4 for what was cut and why) |

