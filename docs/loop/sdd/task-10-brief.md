### Task 10 — session distillation on run end
**Files:** `src/agents/orchestrator.ts`, `src/session-distill.ts`,
`test/session-distill.test.ts`
- When a retained run reaches `completed`/`error`: `distillSession(env, run)`
  summarizes the run transcript via `env.AI.run(ORCHESTRATOR_MODEL, …)` into ≤10
  durable facts + one session summary, then `memory_bank` each via `Memory` DO
  and `addSession`. Behind env flag `MEMORY_ENABLED` (default on; "0"/"false"
  off). `ctx.waitUntil`, wrapped in try/catch — failure logs and never fails
  the run.
- Tests: distillation input shaping, disabled flag, failure isolation.

