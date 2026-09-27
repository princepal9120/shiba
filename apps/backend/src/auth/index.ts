/**
 * T47/T48 — worker-side auth registry: instanceId → provider controller.
 * The admission gate is provider-agnostic; adding a subscription harness
 * (T49 codex, T50 antigravity) means a module under src/auth/ plus one
 * line here, not a new mechanism.
 */
import type { ProviderAuthController } from "@shiba/shared";
import type { AgentHarness, AgentHarnessName } from "../harness/types.js";
import type { CodingTaskInput } from "../opencode-input.js";
import { antigravitySubscriptionAuth } from "./antigravity-subscription.js";
import { claudeSubscriptionAuth } from "./claude-subscription.js";
import { codexSubscriptionAuth } from "./codex-subscription.js";

interface AuthRegistryEnv {
  AGENT_TOKENS: KVNamespace;
  /** The Worker env carries the binding; the antigravity provider hands it to getSandbox. */
  Sandbox?: unknown;
}

/** Map a harness + run input to its T47 controller, or null when the harness carries no auth requirement. */
export function authControllerFor<Env extends AuthRegistryEnv>(
  env: Env,
  harness: AgentHarness,
  input: CodingTaskInput,
): ProviderAuthController | null {
  if (harness.auth === undefined) return null;
  const instanceId = harness.auth.instanceId(input);
  switch (harness.name as AgentHarnessName) {
    case "claude-subscription":
      return claudeSubscriptionAuth(env, instanceId);
    case "codex-subscription":
      return codexSubscriptionAuth(env, instanceId);
    case "antigravity-subscription":
      return antigravitySubscriptionAuth(env, instanceId);
    default:
      return null;
  }
}

/**
 * The admission gate: a subscription-authed harness may start a run only
 * while its auth flow reads `succeeded`. Called after resolveHarness,
 * before a container spins up — a signed-out or never-authed account
 * refuses here, and clear() makes the harness unselectable without
 * touching selection code (T47 rule 3: admission closes first).
 */
export async function assertHarnessAuthorized<Env extends AuthRegistryEnv>(
  env: Env,
  harness: AgentHarness,
  input: CodingTaskInput,
): Promise<void> {
  const controller = authControllerFor(env, harness, input);
  if (controller === null) return;
  const snapshot = await controller.snapshot();
  if (snapshot.phase !== "succeeded") {
    throw new Error(
      `Harness ${JSON.stringify(harness.name)} has no authenticated account ${JSON.stringify(controller.instanceId)} (auth phase: ${snapshot.phase}).`,
    );
  }
}
