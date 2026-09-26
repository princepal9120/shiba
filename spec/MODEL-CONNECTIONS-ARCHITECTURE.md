# Model connections and purpose-based routing — architecture plan

**Status:** proposal only; no application behavior is implemented by this document.  
**Researched:** 2026-09-26. Provider capabilities, terms, model IDs, and API shapes must be rechecked immediately before each integration ships.  
**Product boundary:** `spec/GOAL.md` is authoritative. The deployment is single-tenant and account-owned; this plan does not silently turn it into a multi-tenant SaaS.

## 1. Decision in one page

Add a **connection catalog** and a **purpose policy** on top of the existing harness and Sandbox egress seams. Let a deploy owner configure supported API credentials, let Access-authenticated users select an available model for a task, and freeze the chosen connection/model/harness in the exact approval input. **Model-provider keys remain in Cloudflare AI Gateway BYOK and are injected at Gateway egress only.** Devin/Cursor service API keys remain Worker-side. Neither kind enters a container, browser response, prompt, run record, approval card, or log.

Do **not** present “Connect with OAuth” for every brand. Authentication to the dashboard, entitlement to a subscription, a model API credential, and a remote agent service are four different things. The supported connection method must be listed per service below. In particular, Anthropic explicitly prohibits a third-party app from offering Claude.ai login or routing users' Free/Pro/Max credentials; use Claude API credentials for Claude Opus. [Anthropic legal guidance](https://code.claude.com/docs/en/legal-and-compliance)

Recommended delivery order: (1) stabilize current tests, (2) deploy-owner API/BYOK connections and a coding-model picker, (3) purpose policies for the parent and automations, (4) OpenCode Go, (5) Devin/Cursor service integrations, (6) only then consider personal connections or any officially authorized OAuth flow.

## 2. Current implementation — reuse rather than replace

| Existing seam | Current behavior | Planned change |
|---|---|---|
| `apps/backend/src/harness/index.ts`, `types.ts`, `opencode.ts`, `claude-code.ts`, `codex.ts`, `devin.ts` | Four harnesses; validates `provider/model`; OpenCode allows Google/Anthropic/OpenAI; others have narrower namespaces. | Keep this seam for **local coding CLIs**. Add model/connection capabilities, not brand-specific auth logic to every harness. |
| `apps/backend/src/agents/orchestrator.ts` | `delegate_coding_task` has `harness` and optional `codingModel`; `needsApproval: true`; deploy-wide defaults. | Resolve and freeze a `connectionId`, `modelId`, harness, purpose, and policy version **before the approval card**. Revalidate availability before dispatch; never silently substitute a model. |
| `apps/backend/src/opencode-input.ts`, `agents/opencode-agent.ts` | Structured parent→child envelope, then harness selection. | Carry only immutable non-secret routing identifiers and the approved repo/task. |
| `apps/backend/src/sandbox.ts`, `egress.ts`, `runtime.ts` | Per-run host allowlist; dummy provider key in container; Worker egress forwards to AI Gateway or attaches Devin secret. | Bind egress to approved connection + exact upstream host/path; look up credential in Worker; prevent container-supplied provider/connection override. |
| `apps/backend/src/harness/catalog.ts`, `apps/backend/src/setup-status.ts`, `apps/backend/src/index.ts` | Static CLI catalog and configuration-presence status; `/api/agents` and `/api/setup/status`. | Add a connection/model catalog and authenticated management routes; keep secrets and token fragments out of responses. |
| `apps/frontend/src/components/TaskComposer.tsx`, `AgentsView.tsx`, `apps/frontend/src/app.tsx` | Harness picker, but no explicit model picker; composer sends a prose chat instruction with harness. | Add purpose-aware model picker and Connections settings; send a typed/frozen choice through the existing queue path, not a prompt that asks the parent to guess. |
| `apps/backend/src/automations.ts`, `automation-runner.ts`, `session-distill.ts`, `slack-mention.ts`, `result-quality.ts` | Workers AI/TypeSafe uses are independently hardwired; distillation shares orchestrator model. | Migrate purpose by purpose; keep specialized TypeSafe behavior until a replacement is proven semantically equivalent. |
| `apps/backend/src/access-jwt.ts`, `index.ts` | Access JWT can be verified with `ACCESS_AUD`; dev can opt out; routes use `getUserId`. | Settings/credential mutations require verified Access identity plus deploy-owner authorization, even if ordinary local task routes run without Access. |

The existing security invariant is not negotiable: **human approval of the exact tool input precedes any Sandbox or remote-agent execution**. GitHub credentials remain repo-scoped and Worker-side. A completed run still requires a validated result envelope; an auth or model error is an error, not success.

## 3. Connection support matrix

| Requested name | What it is | Supported path for this product | OAuth status / boundary |
|---|---|---|---|
| **Claude Opus** | Anthropic model family | Anthropic API key stored as AI Gateway BYOK; run via existing `claude-code` or OpenCode Anthropic harness. Get current model IDs from the [Claude Models API/docs](https://platform.claude.com/docs/en/models/overview), not a permanent hardcoded list. | **No Claude Pro/Max OAuth connection in this cloud app.** Anthropic directs third-party products to API-key authentication. |
| **ChatGPT / Codex** | ChatGPT identity/subscription is not an OpenAI API credential | OpenAI API key via AI Gateway BYOK for existing `codex` or OpenCode harness. | “Sign in with ChatGPT” shares identity, not automatically model API access for this app. Codex CLI's own sign-in is a distinct first-party flow; do not harvest or proxy its tokens. [OpenAI sign-in](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt), [OpenAI API authentication](https://platform.openai.com/docs/api-reference/introduction). |
| **OpenCode Go** | Subscription with an issued API key and documented coding-agent endpoints | Add `opencode-go/<model>` to OpenCode, with its documented API key, pinned host/path, model discovery, session header, and an identifying user agent. Route via AI Gateway custom provider only after a live compatibility test; otherwise Worker-side approved egress. | OpenCode's documented flow is **copy API key**, not this app doing account OAuth. Model roster changes. [OpenCode Go](https://opencode.ai/docs/go/). |
| **Devin** | Hosted agent service / CLI, not a raw LLM model provider | Existing `devin` harness already accepts a deploy-wide `DEVIN_API_KEY`; prioritize service-user API key or PAT. Consider direct Devin API adapter later if its session semantics fit this run contract. | No generic Devin OAuth flow is needed here. [Devin authentication](https://docs.devin.ai/api-reference/authentication). |
| **Cursor** | Cursor Cloud Agents is a **remote execution service**, not an interchangeable inference endpoint | Separate `cursor-cloud` executor adapter using the official Cloud Agents API, API key, model list, status polling, cancellation, and result/PR reconciliation. Do **not** add it to `PROVIDER_HOSTS` as if it were a model. | Cursor CLI offers browser login, but official Cloud Agents integrations use user or service-account API keys. [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints), [Cursor CLI auth](https://docs.cursor.com/en/cli/reference/authentication). |
| **opencodex.me** | Third-party/community gateway/proxy project, not an upstream model vendor | **Study and adapt its registry/routing patterns; do not connect its proxy under the current credential contract.** §8 explains the optional alternative requiring an explicit contract change. | Its documented OAuth modes are its own implementation, **not vendor permission for this product**. Do not import browser cookies, CLI credential files, or refresh tokens. [opencodex provider guide](https://opencodex.me/guides/providers/). |

The matrix distinguishes **harness** (which coding program runs), **provider connection** (who pays/authenticates), **model** (which inference ID), and **executor** (local Sandbox versus external Cursor/Devin service). The UI should use these names, not a single ambiguous “provider” dropdown.

## 4. Target architecture and trust flow

```text
Verified Access user ──> dashboard/API ──> connection catalog + purpose policy
                                     │                    │
                              typed run request      metadata only
                                     │                    │
                           orchestrator validates + freezes selection
                                     │
                           human sees exact approval input
                                     │ approve once
                                     ▼
             local: child agent → Sandbox → selected CLI → dummy key
                                               │ approved host/path only
                                               ▼
                              Worker egress → AI Gateway → provider API
                                             model key injected at Gateway

             remote: Worker (service key only) → Cursor/Devin API after approval
                       → poll/webhook → verify result/PR → terminal run
```

### Connection and model records

Use stable, opaque IDs; never use user-supplied URLs or model strings as transport destinations. Suggested *conceptual* records (not a request to add all fields at once):

```ts
type Connection = {
  id: string;
  owner: "deployment" | `access:${string}`; // personal scope only after Phase 5
  service: "anthropic" | "openai" | "google" | "opencode-go" | "devin" | "cursor" | "custom";
  authMode: "gateway-byok" | "worker-service-secret";
  status: "unconfigured" | "ready" | "invalid" | "disabled";
  displayName: string;
  // secret reference / encrypted blob is server-only, never in public projections
};
type ModelOption = {
  connectionId: string;
  modelId: string;       // vendor ID, not a friendly label
  compatibleHarnesses: string[];
  purposes: ("orchestrator" | "coding" | "automation_gate" | "intent" | "quality" | "distillation")[];
  capabilities: string[]; // e.g. tools, structured output, long context
  availability: "verified" | "unverified" | "retired";
};
type ApprovedRoute = {
  purpose: "coding";
  connectionId: string;
  modelId: string;
  harness: string;
  policyVersion: number;
};
```

**Storage:** Phase 1 preserves account-owned AI Gateway BYOK and deployment secrets; persist only connection **metadata** and policies in one small Durable Object (or the existing durable configuration store if one is discovered during implementation). Do not create a generic key vault merely to show a settings UI. A future personal-key design should map verified Access identities to separately provisioned **AI Gateway BYOK aliases**; it may not store raw model-provider keys in D1/KV/DO/Worker secrets or send them from Worker egress. Self-service provisioning would require a separately reviewed owner-authorized Gateway management path; absent that, the deploy owner provisions aliases. [AI Gateway key aliases](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/#key-aliases), [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

**Gateway:** the existing `forwardProvider` uses account-level gateway BYOK. That is suitable for a single-tenant shared connection, not proof of per-user billing isolation. For direct provider-passthrough, AI Gateway documents `cf-aig-byok-alias`; `egress.ts` must strip any container-supplied alias and set only the alias bound to the approved route. **Unified Billing endpoints do not honor non-default aliases**, so they cannot implement personal BYOK selection. Alias selection and billed-key attribution need live tests. [AI Gateway BYOK/key aliases](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/#key-aliases), [custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/).

### Purpose policy

| Purpose | Current source | First safe configurable step | Failure behavior |
|---|---|---|---|
| Parent planning / delegation | `ORCHESTRATOR_MODEL`, Workers AI in `agents/orchestrator.ts` | Select from vetted Workers AI models first; external LLM parent requires an agent-model adapter and tool/approval compatibility tests. | No silent switch to a less capable or differently billed model. |
| Coding run | `CODING_MODEL` / per-harness env + optional tool input | Explicit model + connection in composer, run API, Slack/automation config; capability-filtered by harness. | Refuse before approval if incompatible/unavailable; refuse before execution if connection revoked. |
| Automation `run_when` | TypeSafe Noul, else Workers AI in `automations.ts` | Keep TypeSafe as its own evaluator; optionally select a tested structured-output model via a separate adapter. | **Fail closed**: skip with reason on evaluator failure. |
| Slack intent | TypeSafe Choice in `slack-mention.ts` | Optional replacement only with measured intent-classification contract. | Fail open to unchanged task, as today; do not invent intent. |
| Result quality | TypeSafe Score in `result-quality.ts` | Optional replacement with calibrated grading contract. | Advisory only; unknown is not success. |
| Session distillation | Reuses parent model in `session-distill.ts` | Independent `distillation` choice, with existing Workers AI default. | Best-effort; never change the run's terminal status. |

Resolution order: **approved per-run override** → **automation-specific setting** (for automation runs) → **purpose policy** → **current deploy default**. Only options that are configured and capability-compatible appear in the UI. A route is snapped with the approval and recorded in the run receipt (IDs only). Retry the same route; no hidden provider fallback on 401/403/429, because that changes cost, data destination, and the approved input. A user may explicitly requeue with another route and obtain a new approval.

## 5. Exact codebase integration points

1. **Contracts/catalog:** introduce a small `apps/backend/src/model-connections.ts` for public metadata, capability validation, and purpose policy. Extend `harness/types.ts` only where OpenCode Go adds a real provider host; do not make `Cursor` a fake provider. Add a companion `model-policy.ts` if one file becomes too broad.
2. **Persistent settings:** a dedicated config DO and binding in `apps/backend/src/env.ts`, `apps/backend/wrangler.jsonc`, and `alchemy.run.ts` (plus drift/type-generation scripts) for connection metadata and policy. Start with deployment-scoped records; no secret values in DO in Phase 1.
3. **HTTP/API:** add `GET /api/model-connections`, `GET /api/models?purpose=...`, `GET/PUT /api/model-policy`, and tightly authorized register/test/disable endpoints in `apps/backend/src/index.ts` (or a small route module). Registration accepts a pre-provisioned Gateway alias or service-secret reference, **not a pasted model-provider key**. `GET` returns only status, label, scopes, models, and last-check time. `PUT/POST/DELETE` are owner-only, CSRF-protected, no-store, and never echo credentials. Check a **verified** Access JWT, not a client-sent email header.
4. **Approval/run:** extend the typed queue contract and `delegateInputSchema` in `agents/orchestrator.ts` plus `opencode-input.ts`. Resolve the route before minting the approval pointer; make the card display harness, exact model, connection label, and repo. Revalidate immutable route and connection state at approval and just before dispatch. Include route IDs in receipts, not secret values.
5. **Egress:** extend `sandbox.ts` `approveHarnessEgress`/outbound-handler params and `egress.ts` to bind one approved connection to one allowlisted destination and Gateway BYOK alias. Maintain dummy container keys, stripped incoming auth/cookies/query secrets/`cf-aig-*` controls, manual redirects, GitHub scope, and narrow methods. Test that repo code cannot choose another connection by changing headers, host, URL, or model string. Service APIs (Devin/Cursor) keep their Worker-only keys on their own route.
6. **OpenCode Go:** add documented `opencode-go` config to `harness/opencode.ts`, host mapping in `harness/types.ts` and `sandbox.ts`, and a dedicated forwarder in `egress.ts`. Confirm its API-key endpoint and protocol by a real throwaway call; preserve `x-opencode-session` and an identifying User-Agent. Its model list is remote/cached with TTL and stale indicator, not baked into the Docker image. [OpenCode Go API](https://opencode.ai/docs/go/).
7. **Remote services:** keep Devin's existing harness for now. Implement Cursor as a *separate executor adapter* alongside, not inside, `SandboxRuntimeAdapter` in `runtime.ts`; only start its API run after approval. Map remote IDs to local run IDs, reconcile status/cancel/errors, verify PR and diff provenance, and show that code executes on Cursor infrastructure, not this project's Sandbox. This is a distinct privacy/cost choice requiring explicit UI consent. [Cursor API](https://cursor.com/docs/cloud-agent/api/endpoints).
8. **UI:** add a Connections view/settings panel near `AgentsView.tsx`; add model picker to `TaskComposer.tsx`; wire typed selection and visible route summary in `app.tsx`; update `apps/frontend/src/types.ts`, setup status, approval cards, run details, and onboarding. Show `API key`, `AI Gateway`, or `Not supported` accurately; never a universal “OAuth” button.
9. **Docs/deploy:** update `spec/GOAL.md` only through an explicit product-contract change for personal connections/remote execution; update deployment, configuration, security, and onboarding docs in `apps/web/src/content/docs/docs/`; add required secret/binding checks to `scripts/check-env-types.mjs` and `scripts/check-alchemy-drift.mjs`. No auto-deploy from this plan.

## 6. Phased delivery and acceptance gates

| Phase | Deliverable | Acceptance evidence |
|---|---|
| **0 — baseline** | Resolve the current dashboard-test mismatch without overwriting unrelated uncommitted UI work. | At plan time `pnpm typecheck`, lint, and build passed, but **6 dashboard tests failed (983 passed, 6 skipped)**. All local gates green before feature changes. |
| **1 — shared connections** | Deployment-owner connection metadata for existing Google/Anthropic/OpenAI/Devin; test/status UI; no personal secrets. | Unconfigured/invalid credentials are visible without disclosure; unsupported provider/model is refused before approval; no provider credential reaches container. |
| **2 — coding choice** | Purpose-aware model catalog, composer selection, frozen approved route, run receipt. | Dashboard, direct API, Slack, and automation paths cannot silently override the model; rejection starts zero containers; retry retains same route. |
| **3 — purpose policies** | Parent/automation/distillation choices implemented one purpose at a time. | Tool approval still works under selected parent; `run_when` still fails closed; quality and intent preserve current failure semantics; no hidden fallback. |
| **4 — new providers** | OpenCode Go via API key; Devin integration hardened; Cursor remote executor only if external-execution product boundary is accepted. | Real account smoke tests with a throwaway repo, scoped egress, cancel, error, PR/diff comparison, usage attribution, and credential non-leak checks. |
| **5 — personal connections (separate scope decision)** | Access-subject ownership mapped to separately provisioned Gateway BYOK aliases, rotation/revoke, admin policy, billing/data isolation; no generic in-app model-key vault. | Two-user adversarial tests prove one user cannot list, select, test, spend, or revoke another's connection; account removal invalidates pending runs; model keys remain Gateway-only. |

At every phase: unit tests for compatibility/policy precedence, route auth and CSRF, exact-approval snapshot, egress host/path/header isolation, secret redaction, credential revocation, and honest terminal statuses; then `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, deploy dry-run, and a **non-production** live provider acceptance run. `wrangler deploy --dry-run` validates build/config only; it does not prove vendor auth or end-to-end execution. Record live evidence in `VERIFICATION.md`.

## 7. Decisions to settle before implementation

1. **Ownership:** this plan recommends shared deploy-owner connections first. If “each person connects their own paid account” is mandatory, Phase 5 becomes the first architecture milestone and `spec/GOAL.md`'s single-tenant/account-owned boundary must be amended deliberately.
2. **External execution:** Cursor Cloud Agents sends repository work to Cursor-managed infrastructure; it is not equivalent to selecting a model inside this project's Sandbox. Ship only with explicit opt-in, provenance, and policy/UI disclosure.
3. **OAuth:** add a provider OAuth button only where that provider officially offers and permits third-party authorization for the requested API scope. Subscription-login emulation, imported CLI tokens, and undocumented refresh flows are excluded.
4. **opencodex.me:** use its code as comparative evidence, not a runtime dependency or endpoint. A separately hosted proxy would move key injection outside AI Gateway and is blocked by the current contract until that contract is explicitly changed; it is never a shortcut around provider restrictions.

## Primary references

- [Anthropic Claude Code authentication/legal guidance](https://code.claude.com/docs/en/legal-and-compliance); [Claude model catalog](https://platform.claude.com/docs/en/models/overview)
- [OpenAI Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt); [OpenAI API authentication/models](https://platform.openai.com/docs/api-reference/introduction)
- [OpenCode Go API and usage](https://opencode.ai/docs/go/); [OpenCode providers](https://opencode.ai/docs/providers)
- [Devin API authentication](https://docs.devin.ai/api-reference/authentication)
- [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints); [Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication)
- [Cloudflare AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/); [custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/); [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [opencodex.me provider guide](https://opencodex.me/guides/providers/) (third-party project documentation, **not** upstream-vendor authorization)

## 8. `lidge-jun/opencodex` implementation study and adaptation

Inspected `lidge-jun/opencodex` at commit [`e70b3d8`](https://github.com/lidge-jun/opencodex/tree/e70b3d86fb1201d7951dfeb25e09b7871c433047) through agent-reach's GitHub/`gh` backend on 2026-09-26. This is a **Bun/local proxy and desktop-management product**, not a Cloudflare Worker library; its package exports a Bun source entry and its development server runs through Bun. The MIT license permits pattern study, but no dependency or source copy is proposed.

### What its code actually does

| opencodex mechanism | Source | Adaptation here |
|---|---|---|
| Provider registry declares IDs, wire adapters, fixed base URLs, auth kinds, model metadata and overrides. | [`src/providers/registry/entries-core.ts`](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/providers/registry/entries-core.ts#L110-L132), [`registry/types.ts`](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/providers/registry/types.ts) | Use a **small, explicit** registry of supported connection types and model wire requirements. Keep endpoint and auth kind server-owned; do not accept arbitrary URLs from task prompts. |
| OpenCode Go is registered as key-auth, with an exact destination and model-specific wire behavior; session affinity is generated only for that canonical destination. | [`entries-core.ts` Go entry](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/providers/registry/entries-core.ts#L793-L815), [`opencode-go-transport.ts`](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/providers/opencode-go-transport.ts) | Pin `opencode.ai` plus exact Go paths, bind the API key at egress, and preserve a stable per-run/session ID. Do **not** assume all Go models speak `/chat/completions`; the official Go guide shows Chat, Responses, and Anthropic-shaped paths by model. |
| `routeModel` resolves explicit namespaces, aliases, policies, and a default provider; explicit disabled targets fail. It also has a separate compaction route. | [`src/router.ts`](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/router.ts#L624-L662), [explicit provider resolution](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/router.ts#L750-L779), [route entry points](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/router.ts#L888-L915) | Reuse the **idea** of explicit `connection/model` and separate purpose routing. Do **not** copy its broad default-provider fallback into an approval-gated run; resolve once and freeze, or fail closed. Distillation gets its own purpose, as opencodex keeps compaction distinct. |
| Model visibility and routing are separate: a hidden model can still be directly requested. | [Model-routing guide](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/docs-site/src/content/docs/guides/model-routing.md) | Here, **available for selection** and **authorized for execution** must agree. Server-side admission rejects disabled/retired models even if a client submits the ID manually; hiding a dropdown option is not authorization. |
| Management API separates OAuth-provider and key-provider catalogs, then exposes login/status/logout and masked account lists. | [`oauth-account-routes.ts`](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/server/management/oauth-account-routes.ts#L205-L223), [account routes](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/server/management/oauth-account-routes.ts#L309-L344) | Present **service-specific connect methods** in `AgentsView`/Connections UI. Only expose OAuth where the vendor explicitly authorizes this third-party cloud use. Use masked, server-derived status and separate owner-only mutation routes. |
| Local management identifies a GUI session and requires origin/CSRF proof for consent-bearing mutations; raw admin token is not equivalent to browser consent. | [`management-auth.ts`](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/server/management-auth.ts#L321-L341) | Use verified Cloudflare Access identity + owner role + CSRF defense on connection writes. A bearer/admin credential or forged email header must not approve a vendor login or coding run. |
| Local OAuth credentials live in a file with refresh coordination; optional provider keys live in the OS keychain. | [`oauth/store.ts`](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/oauth/store.ts), [`key-store.ts`](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/providers/key-store.ts#L43-L68) | **Do not copy** filesystem locks, localhost OAuth callbacks, CLI credential imports, or OS-keychain assumptions into Workers/ephemeral containers. Phase 1 uses Gateway BYOK/Worker secrets; any personal-token vault is a separate reviewed design. |
| Cursor and Devin provider entries include experimental/unofficial account bridges, including CLI credential import for Devin. | [`entries-core.ts` Cursor/Devin](https://github.com/lidge-jun/opencodex/blob/e70b3d86fb1201d7951dfeb25e09b7871c433047/src/providers/registry/entries-core.ts#L124-L188) | These are **not** evidence that Cursor or Devin authorizes this app to proxy subscription OAuth. Prefer their documented API keys; Cursor remains a remote-agent executor here. Never import a user's local CLI credentials into the cloud. |

### Two integration options; choose deliberately

**A. Native adaptation (recommended).** Implement only the bounded registry/catalog, model-specific protocol metadata, and deterministic route snapshot in this repository. Keep `Cloudflare AI Gateway → provider` as the normal inference path, `Sandbox` as the normal executor, and the existing approval/egress invariants. This meets the model-choice requirement without adding a resident proxy or duplicating opencodex's broad translation surface.

**B. Operator-hosted opencodex endpoint (not allowed under the current contract).** A separate opencodex proxy would hold/inject upstream provider credentials **outside AI Gateway egress**; that conflicts with this project's standing provider-key boundary. It could only be considered after an explicit `spec/GOAL.md`/agent-contract security change, threat model, and user approval. If ever authorized, pin one HTTPS origin and accepted wire (`/v1/responses` or the documented Claude-compatible path), authenticate Worker→proxy server-side, and require protocol and non-leak smoke tests. Do not expose a generic “paste any URL” field, and do not enable OAuth/forward subscription modes merely because opencodex implements them.

For either option, the end-to-end sequence is: owner configures and tests connection → server discovers/caches only eligible models → user picks purpose/harness/connection/model → orchestrator validates and freezes the route in the approval card → human approves → child starts → egress allows only that route and injects the credential outside the container → result is validated and usage/route IDs are recorded → disconnect revokes future runs and makes pending approvals fail safely. This sequence maps to the file touchpoints in §5 and the acceptance gates in §6.

**Important difference from opencodex:** it is a universal proxy that may route ordinary requests dynamically. This product is an approval-gated coding agent, so dynamic account pooling, policy-driven fallback, and cross-provider retries must not change the approved destination behind the user's back. If an adaptive router is added later, the *complete candidate set, selection rule, cost/data boundary, and resolved route* need their own approval/receipt design first.
