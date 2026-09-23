# Durability pattern decisions

Porting decisions from an agents-API implementation on Cloudflare Workers built on
Effect-TS. We take its durability/error-handling semantics, not its architecture,
and express them in plain TypeScript.

Sources read: its session-state, persistence, session-reservation, reconcile,
errors (the `DEFINITE` table), transport-failure, containers, files, service,
vaults, and supervisor lifecycle modules, plus its architecture and effect docs.

## Decision table

| Pattern | Verdict | Rationale | Flip criterion |
| --- | --- | --- | --- |
| Fenced execution identities (`execution.generation` carried across I/O, re-checked in the writing transaction via `tx.fenced`; stale writer throws `Superseded` and drops) | COPY | Landed in `backend/src/runs.ts` (`DelegatedRun.generation`, `RunStore.transition(..., expectedGeneration)` returns null on mismatch) and `backend/src/agents/orchestrator.ts` (fenced `running` transition + fenced `finish()`). Prevents a late child result overwriting terminal state. | — |
| `outcome_unknown` — acknowledged-then-vanished work is indeterminate, not failed | COPY | `backend/src/runs.ts` terminal `"unknown"` status + `errorCode: "outcome_unknown"` on reclaim; `backend/src/run-errors.ts` wire projection `status: "unknown"`. | — |
| Idempotency reservations (`canonicalJSON` fingerprint of accepted input, `session-kinds.ts` `idempotency` kind) | ADAPT | Landed as delivery-ID dedupe in `backend/src/index.ts` (`gh-delivery:<x-github-delivery>` via `/internal/dedupe`). Theirs fingerprints request content; ours dedupes transport redeliveries. | A write path that can be retried with different delivery IDs needs content-fingerprint idempotency instead. |
| `statusToTurnCode` — HTTP status → error-code mapping shared by all harnesses | COPY | `statusToRunCode` in `backend/src/run-errors.ts` (401/403→authentication_error, 404→resource_not_found, 408→request_timeout, 429→rate_limit_exceeded, 503/529→server_overloaded, other 5xx→server_error, other 4xx→invalid_request, null→internal_error). | — |
| Tagged error union (`Data.TaggedError` classes generated from the `DEFINITE` table, `errors.ts`) | ADAPT | `RunErrorCode` closed union + `RUN_ERROR_DEFS` table + `classifyRunError` in `backend/src/run-errors.ts`. Table-driven user copy is theirs; classes and `catchTag` are not needed without Effect. | If Effect is adopted (see Effect-TS row), the union becomes `Data.TaggedError` subclasses. |
| Turn error-code vocabulary (`TURN_ERROR_CODES` closed list, `isIndeterminate`) | ADAPT | `RunErrorCode` is our closed vocabulary; indeterminacy is exactly `outcome_unknown`. Theirs is a union for SDK turn errors; ours covers agent runs. | If we integrate another provider's error taxonomy verbatim, extend the union rather than free-texting codes. |
| Uninterruptible writes (`Effect.uninterruptible` spans around marker+dispatch, file transfer, commit) | ADAPT | `// UNINTERRUPTIBLE:` markers in `backend/src/agents/opencode-agent.ts` around publish→result-commit. Without a fiber runtime we cannot mask interrupts; the contract is enforced by having no abort check inside the span. | Adopting Effect or a structured-concurrency runtime would turn the marker into a real uninterruptible region. |
| Owned fibers (scope-owned concurrency, work dies with its owner) | SKIP | No fiber runtime; DO lifecycle + `AbortController` registry play the ownership role. | A background loop that must outlive a request inside a DO (e.g. a self-driving reconciler) is when a scope/fiber construct lands. |
| Sync transactions (single-threaded read-modify-write against SQLite) | ADAPT | Already matched: `RunStore.transition` is a synchronous read-modify-write committed to DO state in one step — the generation fence rides it. | Cross-DO or external-store writes would need a different consistency story. |
| Boundary error squashing (one wire projection for API + notifications) | COPY | `runErrorWire(code)` in `backend/src/run-errors.ts` produces `{status, code, userMessage}` for API responses and Slack posts; raw text stays on the record post-`redactSecrets`. | — |
| R2 checkpoints / artifact store | SKIP-now | Diff and transcript return inline, bounded by `MAX_TOTAL_FILE_CHARS`; no artifact store is needed today. | Observed diff truncation via `MAX_TOTAL_FILE_CHARS` in production flips this to a real artifact store. |
| Harness/sandbox split (separate supervisor + harness containers per session) | SKIP | One sandbox per run; the egress boundary (`backend/src/egress.ts`) keeps provider keys and `GITHUB_TOKEN` out of the container. | A repo-code-vs-agent isolation incident (untrusted repo code reaching the agent's credential surface) flips this. |
| Agents API surface (OpenAI-Agents-compatible REST: sessions/turns/messages) | SKIP | Our surface is a dashboard + Slack + webhooks; no client SDK contract. | External consumers needing a programmatic session API flip it. |
| Multi-tenancy (environments, per-customer isolation) | SKIP | shiba-ai-coworker is self-hosted, single-tenant by design. | A hosted product shape flips it. |
| Effect-TS (the runtime carrying their semantics) | SKIP | Patterns ported in plain TS (see `docs/alchemy-effect-evaluation.md` S8.1); the library's value here — typed errors, interruption, DI — is already covered by the D1–D5 ports. | A reconciler loop or interruption inside arbitrary awaits — semantics plain TS cannot express — flips it. |
| MCP vaults (`vaults.ts` per-tool credential vaults) | SKIP | Provider credentials terminate at the egress proxy; no user-supplied MCP servers exist yet. | User-supplied MCP servers with per-tool credentials flip it. |
| Service-binding auth (worker↔worker authenticated bindings) | SKIP | Internal calls (orchestrator DO ↔ automations DO) traverse namespace stubs inside the account; public edges are HMAC-verified. | An internal endpoint becoming publicly reachable flips it. |
| Alarm reconciler (`reconcileTick` driven by a re-arming DO alarm while a turn is active) | ADAPT | Ours is deadline-reclaim: `reclaimStaleRuns` marks stale runs `unknown` on access rather than a self-driving tick. The semantic — crash leaves indeterminate, not failed — is preserved. | When a run must make progress without inbound requests, a real alarm loop lands. |
| SSE replay (replayable session-event log for reconnecting clients) | SKIP | UI reads the run record + live AIChatAgent stream; no replayable event log. | A client needing mid-run resume after reconnect flips it. |
| Transport-failure classification (`CONNECTION_FAILURE` regex over socket/undici messages) | SKIP-now | `classifyRunError` deliberately extracts status only via explicit context (`status[:=] NNN`) and falls back to `internal_error`; transport prose stays unclassified to avoid over-matching. | Misclassified transport errors showing up as `internal_error` in triage often enough to matter flips it. |

## Notes

- "Landed" files are cited in the Rationale column and checked by
  `scripts/check-cf-patterns-doc.mjs` (wired into `pnpm test` via
  `backend/test/cf-patterns-doc.test.ts`): COPY rows must name existing files; every
  SKIP/ADAPT row must carry its flip criterion.
- Error classification is intentionally deterministic. The repo already uses
  TypeSafe (`backend/src/typesafe.ts`) where an LLM judgment is warranted; the
  error-classification boundary is not one — a regex that over-matches produces
  wrong wire codes, which is worse than a conservative `internal_error`.
