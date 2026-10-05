# Architecture: `ai-intern` (shiba)

Measured, not remembered. Every number below was read from the tree at commit
`980fa2c` on `main`, 2026-09-27. Where this document disagrees with
`ARCHITECTURE.md`, this document is the measurement and the other is the prose.

Package name is `shiba`. Deploy name is `shiba-ai-coworker`. License AGPL-3.0-only.

---

## 1. The one-paragraph version

One Cloudflare Worker is both the API and the static host for a React dashboard.
Eight Durable Objects hold all authoritative state. A parent orchestrator agent
plans and delegates but never edits a repo. Approved work runs in an ephemeral
Cloudflare Container, one per run, which clones a GitHub repo and executes exactly
one of five agent CLIs. The container holds a dummy provider key; the real
credential is injected at the Worker egress boundary. Nothing starts until a human
approves the frozen input. Result comes back as a diff, an exit code, receipts, and
a draft PR.

---

## 2. Topology

```
                       ┌──────────── ingress (one Worker) ────────────┐
  Dashboard ──────────▶│  /api/*            Cloudflare Access          │
  Slack ──────────────▶│  /api/slack/*      signature-verified          │
  Telegram ───────────▶│  /api/telegram/*   header secret               │
  Discord ────────────▶│  /api/discord/*    signature-verified          │
  Email ──────────────▶│  /api/emails|drafts  provider-verified         │
  GitHub ─────────────▶│  /api/github/webhook  signature-verified       │
  Cron (*/5 * * * *) ─▶│  automations sweep                            │
  MCP clients ────────▶│  /mcp            bearer token (OAuth: T29)     │
  Sandbox (container) ▶│  /agents/*, /internal/*                        │
                       └──────────────────────┬──────────────────────────┘
                                              ▼
   ┌──────────────── Durable Objects — the only authoritative state ─────┐
   │ CodingOrchestrator  1793 LOC  plans, delegates, never edits        │
   │ OpenCodeAgent                  sandbox-side coding sub-agent       │
   │ Sandbox                         container lifecycle per run        │
   │ Automations                     cron/webhook triggers + budget    │
   │ Mailbox                         inbound email                      │
   │ Memory            1184 LOC     banked facts + Vectorize recall    │
   │ ModelConfig                     model connections + purpose policy │
   │ Waitlist                        signups                            │
   └──────────────────────────────┬─────────────────────────────────────┘
                                  ▼  delegate_coding_task (approved)
   ┌──────────── Sandbox container — ephemeral, one per run ─────────────┐
   │ scoped clone → configure → ONE harness CLI → collect diff          │
   │ egress deny-by-default: selected harness's provider host + git only │
   │ image pins 5 CLIs; dummy key inside, real key at Worker egress     │
   │ max_instances: 5, instance_type: standard-1                        │
   └──────────────────────────────┬─────────────────────────────────────┘
                                  ▼
   AI Gateway (BYOK)  ←  Workers AI (planning)  ←  TypeSafe (run_when)
   GitHub API (PR)    ←  R2 attachments  ←  D1 audit  ←  KV agent tokens
   Browser Rendering  ←  preview screenshots (T33)
```

---

## 3. The numbers

| Measure | Value |
|---|---|
| Backend source | 21,330 LOC, 60 modules |
| Largest modules | `orchestrator.ts` 1793 · `index.ts` 1677 · `mailbox-store.ts` 1422 · `memory-do.ts` 1184 |
| `index.ts` | 1677 LOC, 20 route branches — the concentration risk |
| Test files | 79, all in `apps/backend/test/` (not colocated) |
| Harnesses registered | 7 |
| Harnesses runnable in sandbox | 5 |
| Durable Objects | 8 |
| Supporting stores | 4 (D1, KV, R2, Vectorize) |
| Deploy paths | 2 (`alchemy.run.ts` primary, `wrangler.jsonc` rollback) |
| Ingress surfaces | 8 |
| Live-verified harnesses | 1 (OpenCode only) |

---

## 4. Bindings, as declared

From `apps/backend/wrangler.jsonc`, compatibility date `2026-06-01`,
`nodejs_compat` on.

| Binding | Kind | Notes |
|---|---|---|
| `ASSETS` | static assets | `../../public`, 404-page fallback, serves the dashboard |
| `AI` | Workers AI | parent planning model |
| `BROWSER` | Browser Rendering | headless Chromium for T33 screenshots |
| `LOADER` | worker loader | |
| `SEND_EMAIL` | email sending | recipients come from approved frozen payloads |
| `CodingOrchestrator` | DO | |
| `OpenCodeAgent` | DO | |
| `Sandbox` | DO + Container | `shiba-ai-coworker-sandbox`, `./Dockerfile` |
| `Automations` `Mailbox` `Memory` `Waitlist` `ModelConfig` | DO | |
| `ATTACHMENTS` | R2 | email bodies > 256KB |
| `AGENT_TOKENS` | KV | keyed `tok_<sha256(raw)>` |
| `AGENT_AUDIT` | D1 | MCP tool-call audit, arg hashes never args |
| `MEMORY_VECTORS` | Vectorize | 768-dim cosine, `agent` metadata index |
| cron `*/5 * * * *` | trigger | automation sweep |

Vars: `GATEWAY_ID=default`, `ORCHESTRATOR_MODEL=@cf/zai-org/glm-4.7-flash`,
`CODING_MODEL=google/gemini-3.5-flash-lite`, `RUNTIME=sandbox`,
`INSTANCE_TYPE=standard-1`, `WORKER_HOSTNAME` (empty disables PR screenshots,
capture fails safe and never fails the run).

`preview_urls: false` — version preview URLs are deliberately not exposed, because
the header-only Worker gate is not authentication.

---

## 5. The five security invariants

This is the real contract. Steps 3 and 6 of the run lifecycle are load-bearing;
everything else is replaceable.

1. **Approval before execution.** No sandbox starts without a human approving the
   *frozen* input. `ApprovedRoute` freezes what was approved and revalidates at
   dispatch.
2. **Deny-by-default egress.** `allowedHosts` is the selected harness's provider
   host plus git. Never the union across harnesses.
3. **Scoped git credentials.** `github.com` defaults to refusal;
   `approveRepoScope("/owner/repo")` installs a repo-scoped forwarder before the
   clone, so repo code cannot reach another repo the token can see.
4. **Secrets stay out** of the container, logs, URLs, and UI. Dummy key inside,
   real key at egress. Automation webhooks are header-only.
5. **Per-surface authentication.** Access-gated APIs, signature-verified Slack and
   GitHub, header-secret Telegram/Discord/email, bearer `/mcp`, plus a narrow
   explicit bypass list. A new surface adds its own mechanism, never inherits one.

---

## 6. Run lifecycle, nine steps

```
1  ingress    surface auth, then dispatch
2  intent     orchestrator plans; prose becomes structured delegate_coding_task
3  gate       approval card with exact frozen arguments; human approves
              (automations: approval by default, narrow unattended opt-in)
4  dispatch   approved input frozen; route revalidated at dispatch
5  sandbox    ephemeral container: scoped clone, configure, run harness CLI
6  egress     Worker swaps dummy key for the real provider key
7  collect    diff, exit code, structured envelope (error is never completed)
8  publish    branch + PR; optional screenshot via Browser Rendering
9  cleanup    container destroyed, short sleep tail, receipts recorded
```

Steps 3 and 6 are the ones that must not drift. Every parity feature that touches
ingress is a chance to weaken one of them, which is why they are acceptance
criteria rather than context.

---

## 7. Harnesses

One image ships five CLIs. A run selects exactly one. Registered defaults live in
`harness/index.ts`; versions are pinned in the Dockerfile and mirrored in
`harness/catalog.ts` — **bump both**.

| Harness | Binary | Default model | Credential | Runnable |
|---|---|---|---|---|
| `opencode` | `opencode` | `google/gemini-3.5-flash-lite` | AI Gateway BYOK | yes |
| `claude-code` | `claude` | `anthropic/claude-sonnet-4-6` | AI Gateway BYOK | yes |
| `codex` | `codex` | `openai/gpt-5.3-codex` | AI Gateway BYOK | yes |
| `grok` | `grok` | `xai/grok-4.6` | AI Gateway BYOK | yes |
| `devin` | `devin` | `devin/swe-2` | `DEVIN_API_KEY` secret | yes |
| `cursor` | `cursor` | `cursor/claude-4-5-sonnet` | — | **no** |
| `antigravity` | `agy` | `google/gemini-3.5-flash` | — | **no** |

`resolveHarness` refuses cursor and antigravity **before** the approval card, so a
bad selection never surfaces as an exec error inside the container. Cursor is a
remote-executor connection whose API-key→token exchange stores tokens in the
container and cannot hold the dummy-key invariant. That is the reason, not a gap.

Grok runs verified headless print mode (`--single` + `streaming-json`) pinned to
the `api.x.ai` forwarder via `GROK_MODELS_BASE_URL`; the shared ACP transport was
tried and dropped.

`coding-model.ts` asserts the configured model is not on a retired deny-list at
first request. Defaults are not availability guarantees.

---

## 8. Module map

```
apps/backend/src/
  index.ts            1677  ingress router, hand-rolled, 20 route branches
  orchestrator.ts*    1793  approval gate, delegation, planning
  mailbox-store.ts    1422  email persistence
  memory-do.ts        1184  banked facts, Vectorize recall
  mcp-email-tools.ts   885  MCP surface over email
  automations.ts       828  trigger evaluation, budget, kill switch
  runtime.ts           489  RuntimeAdapter seam, diff/porcelain parsing
  slack-approval.ts    443  approval cards in Slack
  opencode-agent.ts    336  sandbox-side agent
  mcp-gateway.ts       324  stateless MCP (T29a), bearer-only
  egress.ts                  egress handlers, GATEWAY_PROVIDERS
  provider-gateway.ts        dummy key, header sanitation
  security.ts                boundTail, redactSecrets
  runs.ts / receipts.ts      run state, append-only evidence log
  sandbox.ts, sandbox/lifecycle.ts   container lifecycle
  harness/                   7 adapters + registry + types
  *-do.ts                    Automations, Mailbox, Memory, Waitlist, ModelConfig

apps/frontend/src/
  routes/            __root.tsx, app.tsx (TanStack Router, 2 route files)
  components/        21 components: ApprovalCard, DiffViewer, StepTimeline,
                     RunRegistryView, MissionsView, GatesView, MemoryTab,
                     WorkspacePanel, VMInspector, AuditPanel, TaskComposer
  ui/                design-system primitives

apps/web/src/        Astro: content/docs, content/journal, pages/blog
packages/shared/src/ run, receipt, approval, steering, chat, mailbox, mcp,
                     memory, model, audit, run-errors types
apps/backend/test/   79 test files, vitest.config.ts
alchemy.run.ts      primary deploy     wrangler.jsonc  rollback path
```

`index.ts` at 1677 LOC with 20 hand-rolled route branches is the largest
structural risk in the codebase. It is a concentration point for auth logic, which
is exactly the thing invariant 5 says must stay per-surface.

---

## 9. Where new work goes

| If the change is… | It belongs in | Because |
|---|---|---|
| a new way in | ingress + a lane module | every surface authenticates independently |
| a new agent CLI | `harness/` + Dockerfile + catalog | one image, per-run selection, per-harness egress |
| a new stateful thing | a new DO + migration tag | DOs are the only authoritative state |
| a new model or provider | `model-connections` / AI Gateway | credentials stay at the egress boundary |

The ongoing cost of the bring-your-own-agent differentiator is real: every harness
multiplies the risk that a CLI changed its stream format. Treat format changes as
breaking and pin versions.

---

## 10. Known gaps, recorded so they are not rediscovered

- `/mcp` is bearer-only. No OAuth discovery, so third-party MCP clients cannot
  connect. Gates T29.
- No interactive web chat. The dashboard submits and polls; no conversational
  steering surface.
- GitHub is the only repo provider, by decision. The approval gate is already
  provider-agnostic, so adding one is a layer, not a redesign.
- Single-tenant by contract. Reversing it is a product decision for `spec/GOAL.md`.
- `spec/GOAL.md` still forbids a monorepo; the repo is `apps/*` + turbo + alchemy.
  Documentation debt with real cost.
- **No dated live acceptance.** Everything is unit-tested and dry-run verified.
  Only OpenCode has completed a live run. The others are unit-tested against
  documented stream formats. Honest status stays "local prototype".
- `wrangler deploy --dry-run` needs a running Docker daemon and currently fails
  without one.

---

## 11. Reading order

| To understand | Read |
|---|---|
| the request pipeline | `index.ts` → `agents/orchestrator.ts` |
| how a run executes | `agents/opencode-agent.ts` → `harness/index.ts` → `harness/types.ts` |
| the security boundary | `egress.ts`, `sandbox.ts`, `security.ts` |
| state and persistence | the 8 DO classes, `runs.ts`, `receipts.ts` |
| every ingress surface | `slack-routes.ts`, `chat-lane.ts`, `telegram.ts`, `discord.ts`, `email-handler.ts` |
| what is planned and why | `PLAN.md` §17 parity roadmap, §4 for what was cut |
| what is proven | `VERIFICATION.md`, gaps in `VERIFICATION_PLAN.md` |
