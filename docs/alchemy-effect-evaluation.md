# Evaluating Effect-TS and Alchemy.run for ai-intern

Structured evaluation, not a migration plan. Both repos were read, not just homepages.

> **Update:** this was the pattern-port analysis. The project has since adopted both —
> `effect` as a worker dependency (v3 stable) and `alchemy` as a deploy-time devDependency.
> See `src/effect/runtime.ts` and `alchemy.run.ts`; the verdicts below are preserved as
> the evaluation record.

Sources read:
- Effect (`/tmp/effect`, `effect` package version `4.0.0-rc.117`):
  `packages/effect/src/Effect.ts` (`gen` at L1432, `catchTag` L2744),
  `Layer.ts`, `Scope.ts`, `Fiber.ts`, `Ref.ts`, `Queue.ts`, `Schema.ts`,
  `Data.ts` (`TaggedError` at L761). The reference implementation runs the pinned
  v3 line (`3.22.2`) — our references to "Effect" semantics span both.
- Alchemy (`/tmp/alchemy`, `alchemy` version `2.0.0-beta.79`):
  `packages/alchemy/src/Cloudflare/Workers/Worker.ts` (resource + imports
  `effect/Effect` in core), `Workers/InferEnv.ts`, `Stage.ts`,
  `Deploy.ts`, `Plan.ts`, `Destroy.ts`, `AGENTS.md` (IaE resource lifecycle:
  Diff/Read/Pre-Create/Reconcile/Delete, `Binding.Service` capabilities),
  `README.md` (PR-preview `staging-{number}` flow via `uses: alchemy-run/alchemy`).

## S8.1 — Effect-TS pattern portability audit

Question per feature: can we port the pattern in plain TypeScript without the library?

| Effect feature | Verdict | Rationale |
| --- | --- | --- |
| `Effect.gen` / `yield*` (generators as do-notation) | PORT | Plain `async`/`await` already covers sequential composition; the extra layer buys typed error channels we cover with `RunErrorCode` instead. |
| `TaggedError` / `catchTag` | PORT | `RunErrorCode` union + `classifyRunError` + `RUN_ERROR_DEFS` (`src/run-errors.ts`) is the plain-TS equivalent: closed vocabulary, exhaustive table, one wire projection. |
| `Layer` (dependency injection) | PORT | Constructor injection in `CodingOrchestrator`/`OpenCodeAgent` plus the `Env` object covers wiring; we have ~4 seams, not 40 services. |
| `Scope` (acquire → use → release) | PORT | DO lifecycle + `finally` cleanup + `reclaimStaleRuns` cover the acquire/release contract at our granularity. |
| `Fiber` + interruption | PORT | `AbortSignal` propagation + `AbortController` registry + the D5 uninterruptible-write rule is the equivalent at our scale. Flip: a loop needing interruption *inside* arbitrary awaits (fibers can preempt; signal checks are cooperative). |
| `Schema` (vs our Zod) | WATCH | Zod already validates at the webhook boundary (`codingTaskResultSchema` etc.). Schema adds bidirectional encode/decode and Standard-Schema interop. Flip: needing to serialize typed values across the DO↔worker boundary, or adopting a library whose contract is Standard-Schema. |
| `Ref` / `SynchronizedRef` | PORT | DO state writes are single-threaded read-modify-write committed synchronously (`RunStore.transition`); a mutex'd ref buys nothing there. |
| `Queue` | SKIP | No Queue binding exists today (per standing constraint, no new bindings). Flip: webhook fan-out outgrowing `ctx.waitUntil` or needing per-message retry is when Cloudflare Queues land — and then Effect `Queue` is a candidate API on top. |
| `Stream` (SSE for run events) | WATCH | Run events reach the UI via the AIChatAgent message stream + run-record polling; Effect `Stream` would add composable backpressure and replay. Flip: a replayable event log (the SSE-replay row in `docs/cf-open-agents-patterns.md`) landing is when a real Stream abstraction is worth it. |

**Overall:** every Effect feature we need has a plain-TS equivalent already landed
(D1–D5) or a named flip trigger. The library's marginal value is lowest exactly
where a Durable Object's single-threaded transactional state already answers the
same questions.

## S8.2 — Alchemy.run for ai-intern's own deployment

Alchemy is Infrastructure-as-Effects: Cloudflare resources, bindings and the
worker program declared in one TypeScript file, driven by `plan`/`deploy`/`destroy`.
Confirmed from source: resource providers follow a
Diff/Read/Pre-Create/Reconcile/Delete lifecycle (`AGENTS.md`), `Stage` is an
Effect `Context.Service` (`Stage.ts`), `InferEnv<W>` infers env types from the
Worker resource (`Workers/InferEnv.ts`), and Effect is used inside the core
(`Worker.ts` imports `effect/Effect`).

- **Replaces:** `wrangler.jsonc`, `wrangler deploy`, `scripts/setup.mjs`,
  `.dev.vars` + `wrangler secret put` juggling.
- **Adds:** typed `alchemy.run.ts` program, `plan`/`deploy`/`destroy` lifecycle,
  `InferEnv<typeof Worker>` replacing our hand-maintained env types,
  type-checked bindings/IAM, ephemeral stages (per-PR `staging-{number}` with
  destroy-on-close is documented in their README + root GitHub Action).
- **Requires:** an `alchemy` dependency, a deploy path our users don't know
  (they know `wrangler deploy`), beta software (`2.0.0-beta.79`), and Effect in
  the toolchain even if users never write `Effect.*` themselves.
- **Breaks:** the existing CI/CD path, onboarding docs, and our standing
  "no new dependencies" rule — though that rule targets production worker code;
  a deploy tool is a build-side dep, a weaker objection.
- **Enables:** per-PR preview deployments — disproportionately valuable here
  because ai-intern *is* infrastructure people self-host; a throwaway demo
  environment per PR is a real product surface — plus eliminating the
  env-type-drift bug class via `InferEnv`.

**Verdict: WATCH.** Too new/beta to route users through, and the current
`wrangler deploy` path works. Concrete flip triggers to ADOPT:

1. Alchemy ships a non-beta v2 (or v1 line we can pin) — removes the
   moving-API objection.
2. Per-PR preview environments become an actual ask (a demo/threshold where a
   maintainer wants a throwaway ai-intern per change) — this is the feature
   `wrangler` cannot give us at any version.
3. An env-type-drift bug is observed in production that `InferEnv` would have
   caught — turns a hypothetical into a paid invoice.

## S8.3 — Combined recommendation

Adopt Effect-TS the library? **No** (superseded — see the update note above).
The durability semantics it was carrying in the reference implementation — fenced
identities, `outcome_unknown`, tagged error
vocabulary, uninterruptible writes, sync transactions, boundary squashing —
are now ported in plain TypeScript (`src/run-errors.ts`, `src/runs.ts`,
`src/agents/orchestrator.ts`, `src/agents/opencode-agent.ts`), and the features
we have not needed (`Layer`, `Ref`, `Stream`) are covered by the DO execution
model. The named flip trigger is a reconciler/progress loop that needs
interruption inside arbitrary awaits. Adopt Alchemy.run? **WATCH** — track the
v2 stable line; re-evaluate the moment a per-PR preview environment or a typed
`InferEnv` becomes a concrete need (triggers above).
