/**
 * Shared `setState` for CodingOrchestrator test hosts.
 *
 * Production `setState` (agents/orchestrator.ts) does three things in
 * order: fold pending spine inputs into the incoming write
 * (`applySpine` — approval-diff synthesis, seq assignment, outbox
 * projection via the shared fold functions), commit the state, then
 * drain the buffer. The Agent base class would then persist and
 * broadcast; a test host has neither DO storage nor connections, so the
 * base write is a plain assignment — but the spine flush runs for real,
 * so a behavior change in applySpine/appendBatch/foldOutboxEvent fails
 * a test instead of passing silently. Tests that shadow setState with
 * `Object.assign(this, { state })` skip the flush entirely: buffered
 * inputs leak into the next write and the persisted read model
 * (events/outbox) diverges from what production would hold.
 */
import type {
  CodingOrchestrator,
  OrchestratorState,
} from "../src/agents/orchestrator.js";
import { EMPTY_POLICY } from "../src/model-connections.js";
import type { Env } from "../src/env.js";

type SpineInternals = {
  applySpine(next: OrchestratorState): void;
  spineBuf: unknown;
  state: OrchestratorState;
};

/** Mirror CodingOrchestrator.setState: apply → commit → drain. */
export function setStateLikeProduction(host: unknown, next: OrchestratorState): void {
  const self = host as CodingOrchestrator as unknown as SpineInternals;
  self.applySpine(next);
  self.state = next;
  self.spineBuf = [];
}

/**
 * Bindings a production deploy always has, answered with the empty shapes
 * the reads tolerate: delegation runs `readModelConfig` (ModelConfig DO),
 * onStart sweeps stale drafts (Mailbox DO), and run completion distills
 * (gated by MEMORY_ENABLED, off here because these tests never assert
 * memory). Without them the DO `.get` calls throw into the product's
 * catch-and-warn paths and print expected-error noise mid-suite. Spread
 * into each host's env literal: `env: { ...productionEnvStubs(), Sandbox: {} }`.
 */
export function productionEnvStubs(): Pick<Env, "ModelConfig" | "Mailbox" | "MEMORY_ENABLED"> {
  return {
    ModelConfig: {
      idFromName: () => ({}) as DurableObjectId,
      get: () =>
        ({
          fetch: async () => Response.json({ connections: [], policy: EMPTY_POLICY }),
        }) as unknown as DurableObjectStub,
    } as unknown as Env["ModelConfig"],
    Mailbox: {
      idFromName: (address: string) => address as unknown as DurableObjectId,
      get: () =>
        ({
          fetch: async () => Response.json({ mailboxes: [] }),
        }) as unknown as DurableObjectStub,
    } as unknown as Env["Mailbox"],
    MEMORY_ENABLED: "0",
  };
}
