# Credential broker architecture: replacement for Phases 9-13

Target: `/Users/princepal/oss/ai-intern` (shiba)
Supersedes: Phases 9-13 of `ARCHITECTURE-IMPORT-PROMPT.md`
Reference: a peer AGPL-3.0 agent product @ main, 2026-09-27, pushed same day

---

## What changed and why

`PLAN.md:165` says subscription passthrough should not be built, citing Anthropic's
terms and noting "when a funded competitor builds a native macOS app to avoid doing
a thing, that is the signal."

A competitor shipped. a peer product (AGPL-3.0, same license as this repo)
runs cloud E2B sandboxes and brokers per-account agent credentials in production
today. The mechanism is neither t3code's local `claude auth login` nor the
`claude setup-token` handoff that Phase 10 proposed.

It is a **credential broker with account-owned images**. That is strictly better
than the Phase 10 design for a cloud deployment, and it is what this document
specifies.

The peer product remains a single-tenant-per-user product with its own commercial interest, so
their shipping is evidence that a mechanism exists, not proof that the terms
question is settled for us. The §3 reasoning is narrowed here, not deleted. Read
§3 before planning. The Hoplite precedent stays visible.

---

## The core idea, and the line it does not cross

**The broker holds the credential. The container never does.**

```
  operator's browser  ──▶  provider login page  ──▶  callback to broker
                                                      (Worker-side)
                                                            │
                                              sealed grant, memory-only
                                                            │
                                                            ▼
                                                  sandbox runtime
                                          (holds grant in memory, uses it,
                                           talks to chatgpt.com DIRECTLY)
```

The Worker brokers a **token**. It does not proxy inference traffic. The sandbox
authenticates to the provider itself. That distinction is the whole design and it
is the line between this and actually reselling someone's subscription.

The peer implementation proves it: `apps/server/src/account-access/adapters.ts:182` allowlists
`["openai.com", "chatgpt.com"]` as egress destinations, and
`apps/server/src/voice/handlers.ts:24` hits `chatgpt.com/backend-api/transcribe`
directly. The container reaches the provider. The Worker is a credential authority,
not a man in the middle.

If a proposed design has the Worker forwarding model requests, stop. That is a
different product with different terms exposure and it is out of scope here.

---

## Verified reference implementation

Read these before planning. Line numbers are from `main` at 2026-09-27.

| Concern | File | Detail |
|---|---|---|
| Broker core | `apps/server/src/api/cloud-codex-auth.ts` | 257 lines, `CloudCodexAuth implements CodexExternalAuthProvider` |
| Grant crypto | `apps/server/src/api/cloud-grant-crypto.ts` | RSA-OAEP wrap, AES-256-GCM content encryption |
| Protocol version | `packages/contracts/src/cloud-workspaces.ts:131` | `CloudCodexAuthMode = "legacy-image" \| "broker-v1"` |
| Account image | `packages/contracts/src/cloud-workspaces.ts` | `CloudAccountImage`, per-account, per-provider, versioned |
| Provider state | same | `CloudAccountImageProvider`: disconnected/authorizing/connected/expired/error/missing-tool |
| Memory-only grant | `packages/agents/src/drivers/codex-app-server-client.ts:78` | "without reaching into native auth files" |
| Deadline | same, `:55` | `beforeCodexExternalAuthDeadline`, `codex-auth-reconnecting` |
| Login URL stream | `packages/contracts/src/agent.ts:1235` | `ProviderStartLoginRpc`, `LoginEvent = url \| log \| done` |
| Verified vs file | same, `:305` | `authStatus` distinct from `cliLoggedIn` |
| Login URL allowlist | `apps/server/src/account-access/adapters.ts:176-190` | per-provider domain allowlist, https only, no userinfo |
| Vocabulary | `packages/sandbox-providers/CONTEXT.md` | `_Avoid_` lines separating "sandbox offer" from "provider subscription" |

Two mechanisms from that list are worth copying almost verbatim.

**Fencing.** A grant plaintext carries `workspaceId`, `runtimeGeneration`,
`keyThumbprint`, `authorityIncarnationId`, `authorityEpoch`, `chatgptAccountId`,
`issuedAt`, `expiresAt`. Every one is checked on open. `runtimeGeneration`
invalidates a grant when the machine is replaced. `authorityEpoch` invalidates it
when the account's authority rotates. `keyThumbprint` binds it to the public key
that requested it, so a grant cannot be replayed by a different caller. This is
what stops a stale or stolen grant from outliving the thing that justified it.

**Legacy never migrates silently.** A missing `providerAuthMode` decodes as
`legacy-image`, and a retained workspace never begins requesting broker grants on
its own. Identical discipline to the N-1 rollback rule already enforced in
`packages/db`. Adopt it verbatim for broker protocol versions.

---

## Phase 9 (revised): broker core

Replaces the old shared-auth-core phase. The unit of credential is an
**account image**, not a per-run secret.

```
AccountImage
  accountId, providerId (sandbox placement), authMode ("legacy-image" | "broker-v1")
  generation, state, providers: CloudAccountImageProvider[]
  runtimeVersion, configurationDigest

ProviderState
  providerId, state, method ("subscription" | "api-key" | "custom"), verifiedAt
```

Files:

```
apps/backend/src/auth/
  types.ts            AuthPhase, AuthSnapshot, AccountImage, ProviderState
  controller.ts       ProviderAuthController: begin / verify / clear
  broker.ts           CloudAuthBroker: issue, open, revoke, epoch rotation
  grant-crypto.ts     RSA-OAEP + AES-GCM seal/open, port from the peer implementation
  login-url.ts        per-provider domain allowlist, port from adapters.ts
```

Three invariants, unchanged from before and still load-bearing:

1. **HTTP success is never auth success.** A 200 on token exchange, a delivered
   callback, a stored secret: none of these set `succeeded`. Only a capability
   probe against the live runtime sets it. The peer encodes this as the `authStatus`
   versus `cliLoggedIn` split, where `cliLoggedIn` merely checks a file exists.
   Adopt both fields; they are not redundant.

2. **Flow ownership.** Every flow carries the session that started it. Another
   session may read state, never advance or cancel it.

3. **Sign-out order.** Close admission to new runs, then stop in-flight runs, then
   clear metadata. Idempotent, safe mid-flight.

New, and specific to the broker:

4. **Nothing is durable in the sandbox.** Grants are memory-only. A runtime that
   restarts re-requests. A grant must never survive a runtime generation change,
   which is why `runtimeGeneration` is inside the sealed payload rather than
   checked outside it.

---

## Phase 10 (revised): Codex broker

Codex is the reference implementation, because the peer product shipped it first.

- `CODEX_HOME` shadow layout (shared home + per-instance auth overlay) as designed
  in the previous Phase 11. Keep the continuation-key-versus-account-key
  distinction: continuation identity follows the effective home, account identity
  follows the directory holding `auth.json`.
- Brokered grant replaces disk auth for the sandbox path.
  `getDefaultCodexExternalAuthTokens` in the peer implementation exists so other Codex capabilities in
  the same runtime reuse the grant without touching native auth files. Design the
  equivalent: one grant, one runtime, several consumers, no file access.
- Proactive refresh inside a 5 minute window, single-flight, with a deadline that
  yields `auth-reconnecting` rather than hanging. A blocked consumer set that
  recovers together, so one dead grant does not strand unrelated capabilities.
- Egress: `openai.com` and `chatgpt.com`, direct from the container. Not through
  AI Gateway. `GATEWAY_PROVIDERS` will not have a slug and `forwardProvider` will
  reject it. That rejection is correct. Add a dedicated branch that attaches the
  grant and forwards nothing else.
- Updater runs against the **shared** home, not the overlay. Getting this backwards
  makes updates silently no-op.

---

## Phase 11 (revised): Claude broker

Same broker, different provider. Do not fork the mechanism.

- Login URL extraction uses the per-provider allowlist: `anthropic.com`,
  `claude.ai`, `claude.com`. Port the peer allowedLoginUrl, including https-only,
  no embedded userinfo, and suffix matching (`hostname === domain ||
  hostname.endsWith("." + domain)`) so a hostile `evil-anthropic.com` cannot match.
- `CLAUDE_CONFIG_DIR` layout, never `HOME`. Overriding `HOME` relocates the macOS
  keychain lookup and yields "Not logged in".
- No `ANTHROPIC_API_KEY` in the container on the brokered path.
- Detect a cached Anthropic login in the config dir and refuse rather than
  silently preferring a stale credential over the brokered grant.
- Reuse `parseClaudeCodeEvent` verbatim. Do not fork the parser.

---

## Phase 12 (revised): Antigravity

Unchanged in mechanism from the previous Phase 12, with two broker-era additions.

Loopback callback forwarding and owner-scoped pending callback both stand, with
Peer-equivalent validation ported rather than loosened: http, hostname exactly
`127.0.0.1`, matching origin and pathname, no userinfo, no fragment, exactly one
`state`, and exactly one of `code` or `error`. If `iss` is present it must be
`https://accounts.google.com`.

Additions:

- `CloudAccountImageProvider` gains a `missing-tool` state. Antigravity's `agy`
  binary is not in your image today, so a brokered Antigravity account on a
  provider without the binary is a distinct, reportable condition, not a generic
  failure. Surface it.
- The broker grant is what makes the container-side profile unnecessary on this
  path. Decide explicitly whether `configFile()` still needs to return a profile
  layout, and whether Antigravity joins `SANDBOX_HARNESS_NAMES`. Do not half-enable
  it.

---

## Phase 13 (revised): local runtime

Unchanged. The broker does not apply locally, and that is the point: on the
operator's own machine there is no remote boundary, so `claude auth login` and
`codex login` are ordinary use with no broker, no grant, and no seal.

`src/runtime.ts` is the seam: `RuntimeAdapter` (:65), `SandboxRuntimeAdapter`
(:80), `ComputerPreviewAdapter` (:185), `resolveRuntimeName` (:192),
`createRuntimeAdapter` (:203).

Unchanged hard edges: macOS and Linux first; operator toggle is a security
setting; **no chat-surface intake for local runs**; approval gate does not relax.

---

## Phase 14 (new): protocol versioning and rollback

The piece the peer product got most right and the piece most likely to be skipped.

- `authMode` is versioned. Missing values decode as `legacy-image`. A retained
  workspace never begins requesting broker grants without an explicit action.
- Broker protocol version travels inside the sealed `additionalData`, so a grant
  sealed under v1 cannot be opened by a v2 reader. The peer binds
  `{protocolVersion, providerId, requestId, keyThumbprint, authorityIncarnationId,
  authorityEpoch}` as AAD for exactly this reason.
- `configurationDigest` on the account image. Two images claiming the same config
  are a reconciliation bug.
- N-1 rollback applies to the broker exactly as it does to `packages/db`. Rolling
  the Worker back one release must not strand a grant that only the newer release
  can open. Decide what a v1 Worker does when handed a `broker-v2` grant: refuse
  cleanly is correct, crash is not.

---

## Definition of done, broker phases

Each provable by a test:

- With `authMode` absent, every path behaves exactly as before. No broker request
  is made. Byte-identical behavior.
- A grant sealed for runtime generation N is refused at N+1.
- A grant sealed for authority epoch N is refused at N+1.
- A grant presented by a caller whose key thumbprint differs is refused.
- A grant whose AAD protocol version differs is refused.
- A stored-but-dead credential reports `failed` with a real reason, never
  `succeeded`, and never starts a run.
- `cliLoggedIn` true with `authStatus` not `verified` renders as a warning, not a
  working provider.
- Signing out mid-run stops in-flight runs before clearing metadata.
- No credential appears in a log line, a UI response, argv, or a sandbox file.
- The container reaches the provider host directly. The Worker proxies no
  inference traffic. There is a test asserting the Worker never forwards a
  completion request.

---

## Documentation changes

- `PLAN.md §3`: replace the blanket prohibition with the broker design. Keep the
  Hoplite precedent and the terms citation. State plainly that the change of
  position is because a broker mechanism exists, and that the narrowness
  (broker a token, never proxy inference) is what makes it acceptable.
- `harness/claude-code.ts` and `harness/codex.ts` docstrings: both currently say
  "API-key only". Restate as scoped to the API-key path, point at the broker.
- `ARCHITECTURE.md`: add the broker to the layer table and to §4's state map. Add
  the vocabulary discipline from the peer CONTEXT.md: "account image" is not
  "sandbox provider", "auth mode" is not "billing plan". Name the collisions
  explicitly with avoid-lines, the way `docs/internals/glossary.md` already does.
- `spec/GOAL.md`: note that the broker path bypasses AI Gateway, and that the
  account-owned single-tenant posture is a precondition, not a preference.
- A user-facing note: the operator's own provider terms apply, the credential is
  brokered and never written into a sandbox, and revoking the subscription stops
  runs mid-flight. Product voice, no implementation detail.

---

## Still prohibited

- No Worker-side proxying of inference or completion traffic. Broker tokens only.
  This is the line that keeps the design defensible.
- No `claude auth login` or `codex login` browser flow in the dashboard.
- No managed or hosted offering. Dark by default behind a per-deployment opt-in.
  If T35 multi-tenancy lands, remove rather than rework.
- No `authMode` field on `AgentHarness`. Separate harnesses.
- No durable credential in a sandbox under any circumstance.
- No silent legacy-to-broker migration.
- No deletion of the Hoplite precedent from §3.
- No broker work that delays or destabilizes Phases 1 through 8, which remain
  independent and ship regardless.
