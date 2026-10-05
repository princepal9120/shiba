# Architecture import prompt: t3code + Roomote patterns for `oss/ai-intern`

Target: `/Users/princepal/oss/ai-intern` (aka shiba), `princepal9120/ai-intern`, main
Reads first: `CLAUDE.md`, `AGENTS.md`, `ARCHITECTURE.md`, `spec/GOAL.md`, `PLAN.md` §17

---

## Copy everything below the line into a coding agent with repo access.

```
You have the repo at /Users/princepal/oss/ai-intern (package name `shiba`). Read
CLAUDE.md, AGENTS.md, ARCHITECTURE.md, spec/GOAL.md, and PLAN.md §17 before you
plan anything. Then write a phased plan in the existing issue-tracker format
(`T<n>` sections in PLAN.md, state in the §2.0 table). Do not write code until
I approve the plan.

=== ORIENTATION: THIS IS NOT A GREENFIELD BUILD ===

This is a mature, deployed system. Do not restructure it. Per PLAN.md §17, roughly
80% of Roomote's feature spine already ships. You are importing architectural
*patterns* from two reference repositories, not rebuilding the product.

What already exists and must not be disturbed:
  - 7 agent harnesses behind the AgentHarness interface (harness/types.ts),
    registered in harness/index.ts, with a runnability gate (SANDBOX_HARNESS_NAMES)
    that refuses cursor/antigravity before the approval card
  - an append-only receipt log (receipts.ts, runs.ts) with secret redaction
  - the approval gate, which is the product's core contract
  - the egress credential model: container gets a dummy key, real credential is
    injected at AI Gateway egress, deny-by-default host allowlist per harness
  - Slack, Telegram, Discord, email, GitHub webhook, cron intake
  - an MCP gateway (stateless since T29a)
  - Cloudflare Workers + Containers + 8 Durable Objects + D1/KV/R2/Vectorize

=== REPO ARCHITECTURE: AS-BUILT, AND WHAT EACH PHASE CHANGES ===

Measured on main at commit 980fa2c. Backend is ~21,300 LOC across 60 modules in
apps/backend/src, with 79 test files in apps/backend/test (not colocated, note
that). Treat the left column as truth. If reality disagrees with this table during
planning, reality wins and you say so in the plan.

  apps/backend/src/
    index.ts            ingress router, hand-rolled, mounts every surface
    env.ts              Env type, the binding contract
    runs.ts             run state + transitions          -> Phase 1 (decider)
    receipts.ts         append-only evidence log         -> Phase 3 (typed receipts)
    receipts (cmd)      none                              -> Phase 2 (idempotency)
    runtime.ts          RuntimeAdapter seam               -> Phase 6 (exec), 13 (local)
    harness/
      types.ts          AgentHarness, PROVIDER_HOSTS     -> Phase 4 (capabilities)
      index.ts          registry + runnability gate      -> Phases 10-12 (registration)
      claude-code.ts    API-key only                     -> Phase 10 (new harness)
      codex.ts          API-key only                     -> Phase 11 (new harness)
      antigravity.ts    not runnable in sandbox          -> Phase 12 (profile + gate)
      opencode.ts       default harness                  unchanged
      cursor.ts         registered, not runnable         unchanged
      devin.ts, grok.ts                                   unchanged
    egress.ts           egress handlers, GATEWAY_PROVIDERS -> Phases 10-12 (branch)
    provider-gateway.ts dummy key, header sanitation      -> Phase 3 (scope)
    sandbox.ts          container lifecycle               unchanged
    sandbox/lifecycle.ts                                  -> Phase 5 (checkpoints)
    security.ts         boundTail, redactSecrets         reused by all new code
    orchestrator.ts     approval gate lives here         -> Phase 1, 7, 13
    opencode-agent.ts   sandbox-side agent                unchanged
    pending-approvals.ts                                   -> Phase 2 (receipts)
    mcp-gateway.ts      bearer-only                      -> Phase 7 (OAuth)
    (new) auth/         shared auth core                 -> Phase 9
    (new) git-checkpoint.ts                               -> Phase 5
    (new) exec-allowlist.ts                               -> Phase 6
  apps/backend/test/    79 test files, vitest.config.ts  all new tests land here
  packages/shared/src/  run/receipt/approval/steering types both sides import
  apps/frontend/        React dashboard (TanStack router)
  apps/web/             Astro docs + marketing
  alchemy.run.ts        primary deploy    wrangler.jsonc  rollback path

New code goes in new files with tests in apps/backend/test. Do not grow index.ts
past what it already does; it is an ingress router and nothing else.

The dependency rule that keeps this coherent: a harness may import from
harness/types.ts, security.ts, and shared. It may not import from index.ts,
orchestrator.ts, or any chat module. The auth core may import nothing from
harness/. If a new file needs to violate one of those, the seam is in the wrong
place, say so in the plan rather than importing anyway.


=== SUBSCRIPTION CREDENTIALS: READ BEFORE PHASES 9 THROUGH 13 ===

PLAN.md §3 and §17 record subscription passthrough as prohibited, and that
analysis is correct for a *cloud login-flow* implementation. Phases 9 through 13
replace it with two narrower designs, both of which keep the §3 reasoning intact
rather than overruling it.

  - Phases 9-11 (this file's core answer): a `claude setup-token` style handoff,
    dark by default, self-hosted single-tenant only, token injected at egress and
    never in the container.
  - Phase 12 (the local answer): a `local` runtime adapter, which is the only
    place `claude auth login` is permissible, because there the operator's own
    machine and their own browser are doing the login.

Read PLAN.md §3 in full before planning any of it. Do not let the existence of
Phase 12 or Phase 9 be read as a reversal of §3; each is narrow on purpose.

Do not let any of these phases weaken the five standing rules in CLAUDE.md or the
five security invariants in ARCHITECTURE.md §5. If one appears to, stop and say so.

Phases 1 through 8 are independent of all of this and ship regardless.

--- PHASE 9: SHARED AUTH CORE ---

All three subscription harnesses need the same skeleton. Build it once. Do not
build it three times, and do not let it become a framework: three providers with
one shared state machine and three provider-specific modules.

  type AuthPhase = "idle" | "starting" | "verifying" | "succeeded" | "failed" | "cleared";

  interface ProviderAuthController {
    readonly instanceId: string;
    snapshot(): AuthSnapshot;            // { phase, ownerSessionId, message, expiresAt }
    begin(ownerSessionId: string): Promise<void>;
    verify(): Promise<AuthSnapshot>;      // real capability probe, not "secret stored"
    clear(): Promise<void>;              // idempotent, ordered, see below
  }

Three rules that apply to every provider, and that t3code earns the hard way:

  1. OWNERSHIP. An auth flow belongs to the session that started it. Every
     snapshot carries `ownerSessionId`. Another session observing the flow may
     read state but may not advance or cancel it. Without this, one client
     polling a dashboard can cancel another client's sign-in.

  2. HTTP SUCCESS IS NOT AUTH SUCCESS. A 200 on a token exchange, a callback
     delivery, or a redirect proves bytes moved. It does not prove the credential
     works. Only a capability probe against the real CLI may set `succeeded`.
     t3code states this outright and it is the single most important line in this
     phase. A stored secret is not proof.

  3. SIGN-OUT ORDER. Close admission to new runs first, then stop in-flight runs,
     then clear stored metadata. Reversed or interleaved, a queued or resumed run
     keeps using a credential the operator revoked. Make `clear()` idempotent and
     safe to call twice, and safe to call while a run is mid-flight.

Storage: one Worker secret per account, never a DO field, never a KV value that
could land in a UI response. Account identity is a stable internal id; the
credential itself is only ever read at the egress boundary.

Placement, unchanged from Phases 1-8: this is a Worker concern, not a container
concern. The container receives no plan-tier credential under any phase.

=== READ THE TWO REFERENCE REPOS FIRST ===

t3code: github.com/pingdotgg/t3code
  docs/internals/overview.md, providers.md, connection-runtime.md,
  environment-auth.md
  apps/server/src/orchestration/{decider,projector}.ts
  apps/server/src/orchestration/Layers/OrchestrationEngine.ts
  apps/server/src/persistence/Layers/OrchestrationEventStore.ts
  apps/server/src/provider/{ProviderDriver,Services/ProviderAdapter}.ts
  packages/contracts/src/{rpc,orchestration}.ts

Roomote: github.com/RooCodeInc/Roomote
  AGENTS.md, README.md
  apps/worker/src/run-task/, apps/worker/src/sandbox-server/

Do not copy their code. Extract the pattern, then implement it in this repo's
idioms: Effect, Durable Objects, Cloudflare primitives, turbo, the existing
harness interface.

--- PHASE 1: PURE DECIDER FOR RUN LIFECYCLE ---

Today run state transitions live in runs.ts as patch functions that mutate a
DelegatedRun. That is fine at this scale and I am not asking for full event
sourcing. I am asking for the one property that actually pays: the legality of a
transition becomes a pure function you can test without a Worker, a DO, a
container, or a mock.

Write `decideRunTransition(state, command) -> events | typedError` as a pure
function in @shiba/shared or a new packages/decide. No I/O, no clock, no
randomness, no network, no DO access. It owns:
  - the run state machine (queued -> awaiting_approval -> approved -> running ->
    collecting -> completed | error | cancelled | aborted)
  - which transitions are legal from which state, rejecting the rest with a
    typed error rather than a thrown string
  - approval-gate legality: no transition into `running` without a prior
    `approved` event carrying the approver identity and the exact approved
    tool input hash
  - idempotency: a replayed command returns the prior outcome instead of
    re-applying

Then have runs.ts call it. The patch API can stay as a thin wrapper so existing
call sites do not all churn at once.

Test: a table of every (state, command) pair asserting accept or reject, with no
Worker runtime imported. This is the highest value-per-hour item in the plan.

--- PHASE 2: REAL DURABLE COMMAND RECEIPTS ---

receipts.ts is an append-only *evidence* log, which is the right idea, but a
receipt is currently a human-readable string. It is not idempotency.

Add a command receipt keyed by commandId, separate from the evidence log. On
dispatch: look up the receipt, return the stored result on a hit, otherwise
process and write the receipt in the same DO storage transaction as the state
change. This makes a retried Slack delivery, a double-clicked approve button, and
a redelivered GitHub webhook all safe.

Scope it to the approval path first. `POST /api/runs/:id/approve` is the highest
value: an approver tapping twice, or a Slack card callback firing twice, must not
start two containers.

Keep the evidence log exactly as it is. It serves a different purpose and it is
what the UI reads.

--- PHASE 3: TYPED RUNTIME RECEIPTS, NO POLLING ANYWHERE ---

Find every place this codebase waits on a condition with a sleep, a setInterval,
or a retry loop that checks internal state, and convert it to an awaited receipt.

Durable Objects give you `blockConcurrencyWhile` and `waitUntil`, and
`state.storage` transactions give you ordering primitives. A run reaching
`sandbox.ready`, `clone.complete`, `harness.idle`, or `pr.opened` should be an
awaitable, typed signal that both orchestration and tests can wait on.

Tests especially. Per CLAUDE.md the gate is `pnpm test`. A test that needs a
timeout to pass is a broken test and is hiding a missing receipt. Audit the suite
for sleeps used as synchronization and remove them.

--- PHASE 4: HARDEN THE HARNESS INTERFACE --- ---

The AgentHarness interface is already the right seam. Two additions, both cheap:

  1. `capabilities(): HarnessCapabilities` declaring, per harness and per model,
     what is actually true: streamsText, emitsToolCalls, supportsResume,
     supportsSteering, supportsFileAttachments, canRunTests, maxContextTokens.
     Cursor and Antigravity already fail the runnability gate, but that is a
     list, not a capability. A capability object means a new harness declares what
     it can do and the UI can grey out what it cannot, instead of every call site
     hardcoding a name check.

  2. `verify(result): Promise<VerificationOutcome>` — did this run actually
     produce a verified change? Roomote's whole value is proof attached to the PR.
     Today a run that exits 0 with an empty diff is `completed`. It should not be.
     Verification should be harness-declared where possible: did it edit files,
     did it run the project's test command, did it exit non-zero.

Do not unify the harnesses. Do not add a base class. Extend the interface.

--- PHASE 5: GIT CHECKPOINTING --- ---

Before a run mutates the clone, capture a baseline as a hidden git ref, not a
diff cache. At settle, capture again. Turn diff is baseline -> settled.

This is what makes revert possible. Today a failed run's container is destroyed
and the work is gone with no way to inspect or recover the diff after the fact.
That is a real product gap: "what did it actually change before it broke" is
unanswerable right now.

Storage contract, keep it small:
  capture(ref) / diffBetween(from, to) / restore(ref) / prune(keepLast)

Rules: ref names are derived, never user-supplied; validate every ref before it
reaches git; a diff that exceeds a size cap goes to R2 and the receipt carries the
R2 key. Revert restores the workspace and the harness conversation together or
neither.

--- PHASE 6: SCOPED COMMAND EXECUTION, NOT BLANKET BASH --- ---

Per-harness argv today is a fixed allowlist, which is safe but means no harness
can verify its own work by running tests. Do not solve this with a blanket Bash
grant.

Add a scoped executor inside the container: an allowlist of commands, per-command
timeouts, output caps, and every invocation recorded as a receipt that reaches the
UI. A harness that needs to run `pnpm test` gets exactly `pnpm test`, not `bash`.

This is also what makes Phase 4's `verify` honest. Verification requires execution.

--- PHASE 7: OAUTH 2.1 ON /mcp (PLAN.md T29, the unblocker) --- ---

Per PLAN.md §17.3, this is the highest-value remaining item and it is already
scoped. Roughly 8h. Follow the plan; do not redesign it.

Hard requirements from CLAUDE.md and §17.3:
  - additive. existing static bearer agent-tokens keep working unchanged.
  - the approval gate is provably unchanged for OAuth-issued principals. every
    registerTool dispatch still goes requireScope -> handler -> audit.
  - a client-supplied MCP_PRINCIPAL_HEADER is still stripped, and there is a test
    proving it.
  - code + PKCE, discovery documents served, refresh rotates, revoked token
    refused.
  - grant issuance is rate-limited and audited.
  - secrets never in a URL, a log, or a UI response.

--- PHASE 8: PROOF ATTACHMENT --- ---

Roomote's differentiator is a reviewer can verify without reading the diff line
by line. This repo has screenshot capture in flight (commit 041947d, #23) and
preview plumbing. Finish it: attach the screenshot, the test output tail, and a
live preview URL where the project can serve one, into the PR body and the run
receipts.

A run with no proof and no diff must not report completed. That is the "no fake
success" rule in CLAUDE.md, applied to the case that currently slips through.

--- PHASE 10: CLAUDE SUBSCRIPTION (setup-token handoff) ---

Build on the Phase 9 core. Read t3code's docs/user/providers-claude.md and
apps/server/src/provider/Drivers/{ClaudeDriver,ClaudeHome}.ts first. They are the
reference for the auth mechanics. t3code is a *local* product and gets to use
`claude auth login`; Phase 10 does not. That difference is the whole design.

THREE CONSTRAINTS. All three are load-bearing. Implement all three or the feature
does not ship.

  1. `claude setup-token` handoff, NEVER a `claude auth login` browser flow.
     Never implement a browser-based Claude login in the dashboard. Never
     implement an OAuth authorization server for Anthropic credentials. The
     operator runs `claude setup-token` on their own machine, in their own
     terminal, and pastes the resulting token into a Worker secret. The app
     never drives, brokers, or relays an Anthropic login.

  2. Self-hosted, single-tenant, operator-opted-in only. This ships dark. It is
     inert unless the deployment is account-owned (already the GOAL.md posture)
     AND the operator sets an explicit acknowledgement env var, e.g.
     `ALLOW_SELF_HOSTED_SUBSCRIPTION=1`. If that var is absent, the harness is not
     registered, not listed in the catalog, and not selectable. There is no
     hosted or managed offering of this feature. If T35 multi-tenancy ever lands,
     this feature is removed, not reworked — a shared deployment is exactly the
     "on behalf of their users" case §3 refuses.

  3. The token never enters the container and never becomes a repo credential.
     It lives in a Worker secret, is injected at the egress boundary exactly like
     an AI Gateway BYOK key, and is never written to disk in the sandbox, never
     passed in argv, never logged, never returned in a UI response. The existing
     dummy-key invariant does not apply here, because there is no gateway to swap
     at — so the invariant has to be enforced structurally instead. Design that
     enforcement first, then write the harness.

ARCHITECTURE

New harness `claude-subscription`, registered in harness/index.ts, NOT a mode flag
on the existing `claude-code` harness. A separate harness is required because the
credential path, the egress host list, and the trust model all differ. If you
find yourself adding an `authMode` field to `AgentHarness`, stop and split it
properly.

  - `egressHosts()`: claude.ai, api.anthropic.com, and the consent/refresh hosts
    the CLI actually needs. Enumerate them by observing a real `claude` run
    against a setup-token credential. Do not guess the list and do not reuse
    `PROVIDER_HOSTS.anthropic`, which is the API-key path and is deliberately
    gateway-routed. The subscription path must bypass AI Gateway entirely, so
    `GATEWAY_PROVIDERS` does not apply and forwardProvider's slug lookup will
    reject it. That rejection is correct; give the subscription host its own
    egress branch that attaches the token directly and does nothing else.
  - `configFile()`: writes a `CLAUDE_CONFIG_DIR` layout, never a bare token in
    env. t3code's ClaudeHome.ts is explicit that isolating with `HOME` breaks
    macOS keychain lookup and yields "Not logged in", and that a literal `~` in an
    inherited env value is not shell-expanded. Handle both.
  - `env()`: no `ANTHROPIC_API_KEY` at all. A cached Anthropic login in the config
    dir conflicts with a router token — t3code documents requiring `/logout`
    first. Detect and refuse rather than silently using a stale credential.
  - `buildArgv()`: same `--print --output-format stream-json --permission-mode
    acceptEdits` shape as the existing claude-code harness. Reuse
    `parseClaudeCodeEvent` verbatim; do not fork the parser.

ACCOUNT AND CREDENTIAL LIFECYCLE

Model it as a small state machine, per t3code's `providerSetup.ts` shape but
trimmed to what setup-token needs. Phases: idle, starting, verifying, succeeded,
failed, cleared. No `waiting` phase, because there is no interactive flow for the
app to wait on — the operator pastes a token, then the app verifies it.

Verification is a real capability probe against the CLI, not "the secret was
stored". A stored secret is not proof. If the probe cannot confirm the credential
works, the state is `failed` and the reason is surfaced. Probes must use
initialization only and must never trigger setup as a side effect, because opening
a session can start MCP servers or launch a browser.

An empty catalog must clear a previously cached model list. A cached model list
does not establish current access. Report usage limits as a first-class run
signal: a run that dies on a subscription quota must report "usage limit reached,
resets at X", not a stack trace. Parse that from the stream where the CLI
surfaces it, and never mark such a run completed.

Sign-out closes admission to new runs first, then stops in-flight runs, then
clears stored metadata. Otherwise a resumed or queued run keeps using a
credential the operator has revoked. Make it idempotent.

MULTI-ACCOUNT

Separate accounts are separate harness instances with separate config dirs,
isolated including local conversation state. A run may only resume against the
same account it started on. Compute a continuation key per instance and enforce
it in the Phase 1 decider, not in the UI. Do not put account identity in argv.

HARDWARE-WINS LESSONS TO CARRY OVER

These are t3code's documented traps. Encode them as tests.

  - Setup must never happen as a health-check side effect. Probes use
    initialization only.
  - A capability must describe what the provider can actually do. If the
    subscription path cannot roll back a conversation, say so in
    `capabilities()` from Phase 4 and let the checkpoint boundary reject revert
    before touching files.
  - Updates run only through the owning installer, proven by the resolved
    executable path. An unproven install stays manual but still reports the
    version gap.
  - Two accounts on the same driver must not share mutable session or catalog
    state. Route everything by instance id.

DOCUMENTATION, WHICH IS PART OF THE FEATURE

Update, do not contradict:
  - PLAN.md §3: replace the blanket prohibition with the narrowed design and its
    three constraints. Keep the original reasoning visible. Do not delete the
    Hoplite precedent; it is why the design is this narrow.
  - harness/claude-code.ts docstring: it currently says subscription is
    "deliberately not supported". That is no longer true of the codebase. Restate
    it as scoped to the API-key harness and point at the new one.
  - spec/GOAL.md and ARCHITECTURE.md: add the harness to the catalog and note that
    the subscription path bypasses AI Gateway.
  - A user-facing note stating plainly that the operator's own Anthropic terms
    apply, that the token is stored as a deployment secret, and that revoking the
    subscription stops runs mid-flight. Say it in the product's voice, no
    implementation detail.

Definition of done for this phase, all provable by a test:
  with the acknowledgement var absent, the harness is unlisted and unselectable
  and every existing gate is byte-identical. With it present and a valid token,
  a run completes and opens a PR. With an invalid token, verification fails with
  a real reason and no run starts. Signing out mid-run stops in-flight runs before
  clearing metadata. The token appears in no log line, no UI response, no argv,
  and no sandbox file. A resumed run refuses to cross accounts.

Phases 1 through 8 do not depend on this one. If this phase slips or gets cut,
nothing else is blocked.

--- PHASE 11: CODEX SUBSCRIPTION (CODEX_HOME shadow layout) ---

Different mechanism from Phase 10. Do not copy Phase 10's shape and rename it.
Codex is not a token-in-env provider; it is a directory-shaped credential with a
layout problem t3code solves specifically. Read
apps/server/src/provider/Drivers/{CodexDriver,CodexHomeLayout}.ts and
docs/user/providers-codex.md.

THE LAYOUT PROBLEM

Codex keeps credentials in `auth.json` under `CODEX_HOME`. A single shared home
means every instance shares one account and one credit pool, which is wrong the
moment an operator has two. t3code's answer is a two-level layout:

  - a SHARED home holding everything that is not account-specific (sessions,
    config, installed binaries)
  - a per-instance SHADOW home that overlays only auth plus a few local entries,
    materialized from the shared home at run start

The subtlety worth getting right, and the reason this is called out separately:
the CONTINUATION key and the ACCOUNT key are different keys. Continuation identity
follows the effective home so a conversation resumes against the same history.
Account identity follows the directory that actually holds `auth.json`, because an
auth-overlay instance owns its account under the shadow home while a plain
instance still shares the common one. Keying usage, quota, or sign-out on the
continuation key conflates the two and either double-counts a shared credit pool
or fails to revoke an overlay account. t3code's CodexDriver comments call this
out explicitly; read them before writing the key derivation.

Constraints:

  1. `codex login`-equivalent only via operator handoff on their own machine. No
     browser login flow in the dashboard, same as Phase 10 constraint 1.
  2. Dark by default behind its own acknowledgement var, distinct from Phase 10's,
     so an operator can enable one provider without the other. Same
     self-hosted single-tenant rule. Same removal-not-rework rule if T35 lands.
  3. `auth.json` is the credential. It never enters the container as a file, never
     appears in argv, never in a log or UI response. The shadow home is
     materialized in the Worker, read at egress, and discarded.

Egress: Codex subscription traffic does not go through AI Gateway, so
`GATEWAY_PROVIDERS` will not have a slug and `forwardProvider` will reject it.
That rejection is correct. Give the subscription hosts their own egress branch,
same as Phase 10, and keep it deny-by-default.

Update path: t3code runs the updater against the SHARED home, not the instance's
effective home, because the overlay does not contain the installation. Getting
this backwards makes updates silently no-op. Copy that decision and the comment
explaining it.

--- PHASE 12: ANTIGRAVITY SUBSCRIPTION (loopback callback) ---

The most interesting of the three, and the one most likely to be got wrong. Read
apps/server/src/provider/{AntigravityAuth,antigravityAuthSupport,antigravityCallback}.ts
plus docs/user/providers-antigravity.md. Note that this harness is currently
registered but NOT runnable in your sandbox (harness/types.ts,
SANDBOX_HARNESS_NAMES excludes it), so this phase also has to resolve that.

MECHANISM

Antigravity authenticates through an ACP subprocess that prints an authorization
URL on stdout and then listens on a loopback callback. The URL is surfaced to the
operator, the operator signs in with Google in their own browser, Google redirects
to 127.0.0.1 on a port the *subprocess* is listening on, and the credential lands
in the subprocess's profile. The Worker never sees a password and never proxies
the Google login.

Two properties make this correct in a remote deployment, and both must be
implemented:

  1. CALLBACK FORWARDING. The loopback listener is inside the container, on the
     container's own loopback, which the operator's browser cannot reach. So the
     container must expose the callback on an ingress and the Worker forwards the
     operator's pasted redirect URL into it. t3code's AntigravityAuth carries a
     `forwardCallback` and an owner-scoped pending-callback record for exactly
     this. The alternative, telling the operator to port-forward into a container,
     is not shippable.

  2. OWNER-SCOPED PENDING CALLBACK. Only the callback advertised by the currently
     running ACP process may be completed. Bind the pending record to the flow id
     and the single expected `state` value, and reject a callback that does not
     match. t3code's antigravityCallback.ts validates exhaustively and you should
     port the checks rather than invent looser ones: protocol is http, hostname is
     exactly 127.0.0.1, origin, pathname, no username, no password, no fragment,
     exactly one `state` matching the pending value, and either exactly one `code`
     with no `error` or exactly one `error` with no `code`. A `iss` param, if
     present, must be `https://accounts.google.com`. Anything else is not a Google
     sign-in response and must be refused.

  Then, and this is the rule from Phase 9 that Antigravity most obviously needs:
  a successful callback delivery is NOT authentication. The ACP process owns token
  exchange and storage; only a probe against the started process sets `succeeded`.

PROFILE ISOLATION

Antigravity forces file-based credential storage rather than the native macOS
keychain, precisely because a keychain entry would be shared across instances.
The launch environment must strip ambient Google credentials so one instance
cannot silently use another's account or billing project: remove GEMINI_API_KEY,
GOOGLE_API_KEY, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT,
GOOGLE_CLOUD_LOCATION, GOOGLE_CLOUD_QUOTA_PROJECT, GOOGLE_GENAI_USE_VERTEXAI and
siblings. Port t3code's `removedEnvironmentKeys` set rather than guessing at it.

A profile also resolves its own user-global skill directories. Keep that boundary
intact: the profile links those directories back to the operator's real home, but
MCP servers, hooks, and rules living there must stay outside the profile.

INSTALLER OWNERSHIP

The Antigravity installer outlives client connections and instance rebuilds.
Releases are immutable with an atomic pointer selecting the version for new
processes, and running processes hold leases. Updates and removal must respect
those leases rather than replacing executables under a live agent. This is a real
class of bug and t3code's AntigravityInstallation.ts is the reference.

SANDBOX RUNNABILITY

Your antigravity harness currently returns `configFile(): null` and is excluded
from SANDBOX_HARNESS_NAMES. Subscription auth needs a profile directory written,
so `configFile()` must return a real HarnessConfigFile, and the image must contain
the `agy` binary. Decide explicitly whether the subscription path makes it
runnable; if it does, add it to SANDBOX_HARNESS_NAMES with the profile
materialization, and if it does not, leave it excluded and say why in the plan.
Do not half-enable it.

Constraints 1 through 3 from Phase 10 apply verbatim, with their own
acknowledgement var.

--- PHASE 13: LOCAL RUNTIME ADAPTER (where login flows become legal) ---

This is the answer to the gray area PLAN.md §3 names, and it is a separate
runtime, not another harness.

Your `src/runtime.ts` already abstracts where work runs, and it is the seam to
extend: `RuntimeAdapter` (runtime.ts:65), `SandboxRuntimeAdapter` (:80),
`ComputerPreviewAdapter` (:185), `resolveRuntimeName` (:192) returning
`"sandbox" | "computer"`, and `createRuntimeAdapter` (:203). Add a third: `local`.
Under this adapter the agent process runs on the operator's own machine, so:

  - `claude auth login`, `codex login`, and the Antigravity Google sign-in all
    happen in the operator's own terminal and their own browser, against their own
    machine. That is ordinary use, and it is categorically different from a
    deployed app brokering a login on someone's behalf.
  - No credential transits your Worker, your egress, or any container. The
    invariant that Phases 10-12 go to such lengths to preserve is satisfied here
    by there being no remote boundary at all.
  - The dashboard drives it: start a run, watch it, steer it, stop it. The run
    still passes through the Phase 1 decider, still writes receipts, still obeys
    the approval gate. The approval gate does NOT relax because the work is local.
    That is the invariant to protect here.

Scope it honestly and small:
  - macOS and Linux only to begin. Say so in the docs.
  - Operator-initiated only. The Worker may not start a local run without an
    explicit local-mode toggle set by the operator, and that toggle is a
    first-class security setting, not a preference.
  - No Slack, Telegram, or Discord intake for local runs. A chat message must not
    be able to cause code execution on someone's laptop. Web dashboard only. This
    is the sharpest edge in the whole plan; get it right.
  - The approval card still appears, still gates, and the approver list still
    applies.

Make the runtime seam real: `resolveRuntime()` picks sandbox, computer, or local,
and every harness declares which runtimes it supports. Local runs have a
different filesystem, a different credential story, and a different blast radius,
so a harness that cannot support local must be refused by a capability check
rather than failing mid-run.

This is the phase that makes §3's gray area tractable rather than ignored, and it
is the one to build if the operator wants their own subscription to pay for their
own runs. It is also the phase where the security review matters most.

=== WHAT NOT TO DO ===

Do not convert this to event sourcing wholesale. Runs are not a financial ledger;
the receipt log plus a pure decider plus command receipts gets the properties
that matter at a fraction of the cost. Full event sourcing here would be
architecture for its own sake and PLAN.md's "keep the smallest working
architecture" forbids it.

Do not add Postgres, Redis, or a BullMQ-style queue. Durable Objects are the queue
and the state. Queues and Workflows are explicitly forbidden in spec/GOAL.md.

Do not add a WebSocket RPC layer. The Agents SDK already provides
`routeAgentRequest` over HTTP and WebSocket. t3code's Effect RPC group is a
Node-server pattern and does not apply to a Worker.

Do not add a second deploy path. alchemy.run.ts is primary, wrangler.jsonc is the
rollback, and both must keep declaring the same bindings.

Do not unify the 7 harnesses behind a lowest-common-denominator base class. They
are genuinely different CLIs. The interface is the seam; that is enough.

Do not restructure apps/ or rename packages. pnpm + turbo with backend, frontend,
and web is adopted deliberately.

Phases 9-13 specifically, restated as prohibitions so they cannot be quietly
skipped:
  - No `claude auth login`, `codex login`, or Google sign-in browser flow in the
    dashboard. No Anthropic or Google OAuth server. No login UI. Operator handoff
    only, and in Phase 13, only on the operator's own machine.
  - No managed or hosted offering of any subscription harness. Each is dark by
    default and stays dark without its own explicit per-deployment opt-in.
  - No `authMode` field on AgentHarness. Separate harnesses, not one harness with
    a flag.
  - No plan-tier credential in a container, in argv, in a log, in a UI response, or
    on disk in a sandbox. No exception for debugging.
  - A successful callback, a stored secret, or a 200 from a token exchange never
    sets `succeeded`. Only a capability probe against the real CLI does.
  - No Phase 13 local run without the approval gate, and no chat-surface intake
    for local runs under any circumstance.
  - No deleting or softening the Hoplite precedent in PLAN.md §3. The narrowness
    of Phases 9-13 is a direct consequence of that precedent, and the reasoning
    has to stay visible next to the code that now exists.
  - No Phase 9-13 work that delays or destabilizes Phases 1 through 8.

=== WORKING RULES (from CLAUDE.md, non-negotiable) ===

The approval gate is sacred. No change may weaken it, and Phase 1, Phase 7, and
Phase 13 all touch that path, so prove the gate is unchanged with a test, not a
claim.

Provider keys never enter the container. GITHUB_TOKEN never reaches the container,
a clone URL, a log line, or a UI response. Webhook and automation secrets are
header-only, never query parameters.

No fake success. If a run cannot be verified, it reports error with the real
reason.

Prefer deletion and minimal diffs over new abstraction. Use existing dependencies.

Plan first, code only after I approve. Smallest correct thing. Verify with
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` and the targeted test
files for what you touched. Never repo-wide checks beyond that gate unless I ask.

If a rule here fights the task in front of you, say so loudly and get sign-off
before breaking it.

Start: read the five docs and both reference repos, then write the phased plan in
PLAN.md's existing T<n> format with the §2.0 state table updated.
```
