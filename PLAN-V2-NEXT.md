# PLAN-V2-NEXT — ai-intern next arc

**Revision:** 2026-10-05. Sits on top of PLAN.md rev 11 (P1–P8, T40–T51 done).
**Inputs:** boringcomputers/nehemiah (+ PR#25 Cloudflare port), pingdotgg/t3code
Orchestrator V2 (PR#2829), zed-industries/agent-client-protocol + ACP Registry.
**Constraint:** Effect only at the three existing seams (runtime.ts, lifecycle.ts,
orchestrator.ts); new deps must clear the licensing bar (MIT/Apache/BSD/ISC).

---

## Where we actually are

Already shipped (do NOT rebuild):

| Exists | File(s) |
|---|---|
| Orchestrator DO, fenced transitions, generation capture | `src/agents/orchestrator.ts` (93K) |
| Pure run decider + durable command receipts | `packages/shared/src/decide.ts`, `command-receipts.ts` |
| Typed run signals / receipts | `run-signals.ts`, `receipts.ts` |
| Git checkpoints (turn bracketing) | `src/git-checkpoint.ts` (T44) |
| Harness catalog: opencode, claude, codex, cursor, grok, devin, antigravity (+subscription variants) | `src/harness/*` |
| ACP in container via `cursor-agent --force acp` | `src/harness/cursor.ts` |
| Email intake + approval loop | `src/email-handler.ts`, `src/email-approvals.ts`, `SEND_EMAIL` binding |
| MCP gateway + OAuth + tool surface | `src/mcp-gateway.ts`, `mcp-*-tools.ts`, `oauth-mcp.ts` |
| Mailbox DO (cloud-agent pairing), Memory DO + Vectorize | `mailbox-do.ts`, `memory-do.ts` |
| Slack + Telegram + Discord + dashboard intake | Slack manifest, `discord.ts`, chat-lane |
| Automations (cron triggers) | `automations*.ts` |
| Screenshot + BROWSER binding | `screenshot.ts`, `BROWSER` in wrangler.jsonc |
| Effect runtime boundary, scoped lifecycle, retry | `effect/runtime.ts`, `sandbox/lifecycle.ts`, `harness/retry.ts` |
| Alchemy deploy | `alchemy.run.ts` |

Real gaps vs the reference architectures:

1. **No event-sourced projection.** Decider + receipts exist, but state is still
   mutable `OrchestratorState` fields — no append-only event log, no projection,
   no effect outbox. (T3 V2's core win.)
2. **ACP is harness-internal only.** `cursor-agent acp` is used as a transport,
   but there's no ACP *registry resolver* (task picks any registry agent) and no
   ACP *server* (Shiba itself installable in Zed/JetBrains/T3).
3. **No computer-use surface.** Screenshot exists for evidence; no interactive
   desktop (VNC/noVNC) the agent can drive, no `screen_click`/`screen_type` tools.
4. **No run fork.** `git-checkpoint.ts` reverts workspace, but can't clone a
   live run (Nehemiah's 35ms fork). Closest analog: checkpoint + re-dispatch.
5. **No edge identity signing / internal-route Access gate** (Nehemiah PR#25).
6. **No preview-stage deploys** (`ALCHEMY_STAGE=pr-<n>` workflow).

---

## Phase P9 — Event spine (orchestrator correctness)

T3 V2 proved the shape: command → decider (pure) → events appended → one
transaction applies to read model + persisted projection + receipt → reactors
dispatch side effects. We have the decider and receipts; add the log.

**New files**

- `packages/shared/src/events.ts` — `RunEvent` union: `run.proposed`,
  `run.approved`, `run.rejected`, `run.started`, `run.progress`,
  `run.checkpointed`, `run.completed`, `run.failed`, `run.cancelled`,
  `side_effect.requested|dispatched|failed`, `approval.requested|answered`.
  Schema-validated, `seq` per DO, `causationId`/`commandId` threading.
- `packages/shared/src/projector.ts` — pure `apply(state, event) → state`.
  Current `OrchestratorState` becomes the projection output, not the source.
- `src/orchestration/event-log.ts` — DO-storage append log (`sql` or KV list,
  per-orchestrator seq, replayable). `appendBatch(events)` inside the same
  transaction as state writes.
- `src/orchestration/outbox.ts` — effect outbox: `{ id, kind, payload, status,
  attempts }` rows. Side effects (Slack post, email send, gh push, webhook
  emit) are *requested* as events; an outbox drainer executes exactly-once,
  marks dispatched, retries with the existing `harness/retry.ts` Schedule.

**Rewire**

- `orchestrator.ts`: every mutation site routes through
  `decide → appendEvents → apply` instead of direct state writes. Keep the
  fencing/generation semantics — the log wraps them.
- `reclaimRuns` reads pending outbox entries on wake (this generalizes the
  leak-persistence pattern from PR#5).
- Migration: on first boot post-deploy, replay existing `OrchestratorState` →
  synthesize `run.migrated` events so history is continuous.

**Done when:** kill -9 between approve and Slack post still produces exactly
one notification; `pnpm test` gains `event-log.test.ts` +
`outbox.drain.test.ts`; projector replay of a fixture log equals live state.

---

## Phase P10 — ACP client only: any registry agent in the sandbox

> Scope note: we are NOT shipping Shiba itself as an ACP agent (no
> `npx shiba-acp`, no registry submission, no `AgentSideConnection` server).
> Rationale: Shiba's value is the hosted control plane + approval gates —
> exposing it inside editors means maintaining a public API contract,
> auth/tenant model, and support surface for external clients, for a
> distribution win we don't need yet. Revisit if a partner asks.

- `packages/acp/` (new workspace) — wraps `@zed-industries/agent-client-protocol`,
  `ClientSideConnection` over container stdio.
- `src/acp/registry.ts` — fetch `cdn.agentclientprotocol.com/registry/v1/latest/
  registry.json`, DO-cached (1h TTL), resolve `agent.id` → `distribution`
  (npx/binary/uvx) → install cmd + env. Fail closed on unreachable registry.
- `src/harness/acp-generic.ts` — new `AgentHarness` impl: provision →
  `initialize` → `authenticate` (maps registry `authMethods` to task env
  secrets) → `session/new` → `session/prompt`; `session/update` notifications
  → existing transcript stream.
- Task spec gains `agent: "<registry-id>"` — carried through proposal →
  approval (shown to approver) → run. Dockerfile stays lean; install at
  container start (+5–10s cold per new agent type, cached in image layer later).
- Internal allowlist of registry IDs (`AGENT_REGISTRY_ALLOWLIST`) — don't let
  a task spec pull arbitrary registry entries; curate ~10 vetted agents first.

**Done when:** task `{agent: "gemini-cli"}` runs end-to-end in sandbox with no
code path special-cased beyond the registry entry.

---

## Phase P11 — Computer use (Nehemiah's desktop, Cloudflare-flavored)

- `Dockerfile`: add `chromium`, `xvfb`, `x11vnc`, `novnc`, `websockify`,
  `xdotool`. Entrypoint: `Xvfb :99 & x11vnc & websockify :6080`.
- `src/sandbox/desktop.ts` — `DesktopSession` via `Effect.acquireRelease`
  (acquire = container + websockify health; release = destroy; leaks →
  `leakedContainers` per PR#5 pattern).
- `src/sandbox/vnc.ts` — Worker `/sandbox/:id/vnc` WS proxy → container :6080.
  *(Open call: confirm Sandbox containers expose ports for WS proxying; else
  screenshot-poll + input injection only — document honestly.)*
- Harness tools (already have screenshot evidence path): `screen_click(x,y)`,
  `screen_type(text)`, `screen_screenshot` → `xdotool`/import via exec.
- Orchestrator: `use_screen: true` on task spec → DesktopSession lifecycle.

**Done when:** "open the staging site and click login" task shows a live
stream + the agent's clicks land.

---

## Phase P12 — Fork + TTL

- `src/sandbox/snapshot.ts` — fork = git-checkpoint + env/context envelope →
  new container from checkpoint ref. (True live-memory fork doesn't exist in
  Sandbox containers; document the honest version: filesystem+branch state
  clone, ~seconds not 35ms.)
- `src/sandbox/ttl.ts` — per-run inactivity timer in the Sandbox DO; default
  TTL destroys idle sandboxes; `keep_alive` opt-out; `reclaimRuns` sweeps.
- Orchestrator UI: "fork run" button → sibling proposal seeded from checkpoint.

**Done when:** a run can fork into two parallel attempts; idle sandbox dies
on TTL; `keep_alive` survives.

---

## Phase P13 — Edge hardening + deploy parity (Nehemiah PR#25)

- Edge: Worker signs `CF-Connecting-IP` with HMAC (`EDGE_SIGNING_SECRET`)
  on `/internal/*` routes; internal consumers verify — DOs/containers see real
  caller identity, not the Worker.
- `/internal/*` behind Cloudflare Access service token where applicable.
- `deploy-cloudflare.yml`: prod on main; `ALCHEMY_STAGE=pr-<n>` preview on PRs
  (alchemy stage-suffix naming already prevents collisions — verify
  `check-alchemy-drift.mjs` covers new bindings).
- R2/vectorize/D1/KV bindings: confirm all mirrored in `alchemy.run.ts` (drift
  gate covers this).

---

## Ship order

```
P9  → correctness first; email+Slack+ACP all notify → outbox prevents dups
P10 → biggest product gap; P10a independent, P10b needs P9's API stability
P11 → heaviest infra, lands on stable spine
P12 → cheap once P9/P11 exist
P13 → before any public ACP registry listing
```

## The delta when all shipped

**Today:** multi-harness (OpenCode/Claude/Codex/Cursor/Grok/Devin) on
Cloudflare, Slack/Telegram/Discord/email-gated, Effect boundaries, MCP tools.

**After P9–P13:** the only self-hosted control plane that is
event-sourced-correct (T3 V2's spine), agent-agnostic via the ACP registry
(any vetted agent runs inside the sandbox), with computer-use sandboxes,
forkable runs, and approval-gated async intake — on rented edge compute,
zero install for the requester.

## Open calls (verify before build)

1. Sandbox container port exposure for websockify WS proxy (P11 feasibility)
2. `registry.json` CDN stability + license of each agent's binary dist (P10a)
3. Email Routing: needs custom domain on a zone (which domain for ai-intern?)
4. `effect` RC churn: alchemy beta pins effect@4 RC; budget for API movement
