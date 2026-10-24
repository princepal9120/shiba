/**
 * Purpose-based route resolution (spec/MODEL-CONNECTIONS-ARCHITECTURE.md §4).
 *
 * Resolution order for the coding purpose:
 *   approved per-run override → automation-specific setting → purpose
 *   policy → current deploy default.
 * Non-coding purposes resolve a Workers AI model id from the purpose policy
 * with the deployment var as the floor.
 *
 * Everything here is fail-closed: an unknown connection, a disabled
 * connection, or a model outside the connection's namespace throws *before*
 * the approval card is minted — never inside a container.
 */
import { HARNESS_REASONING_EFFORTS, type ReasoningEffort } from "@shiba/shared";
import type { Env } from "./env.js";
import { HARNESS_NAMES } from "./harness/index.js";
import { modelConfigStub } from "./model-config-do.js";
import {
  EMPTY_POLICY,
  orderConnections,
  reconcileConnectionOrder,
  validateConnectionModel,
  type ApprovedRoute,
  type Connection,
  type Purpose,
  type PurposePolicy,
} from "./model-connections.js";
import { soleReadyConnection } from "./model-defaults.js";
import { assertConnectionEligibleForRun, type RunInitiatorContext } from "./subscription-routing.js";
import { DEFAULT_ORCHESTRATOR_MODEL } from "./session-distill.js";

export interface ModelConfigSnapshot {
  connections: Connection[];
  policy: PurposePolicy;
  connectionOrder: string[];
}

const EMPTY_SNAPSHOT: ModelConfigSnapshot = { connections: [], policy: EMPTY_POLICY, connectionOrder: [] };

/**
 * Read the catalog + policy. Fails open to the empty snapshot: a missing or
 * broken store must degrade to deployment defaults, never block task intake.
 */
export async function readModelConfig(env: Pick<Env, "ModelConfig">): Promise<ModelConfigSnapshot> {
  try {
    const stub = modelConfigStub(env);
    const [connectionsRes, policyRes] = await Promise.all([
      stub.fetch(new Request("https://internal/connections")),
      stub.fetch(new Request("https://internal/policy")),
    ]);
    const connectionsBody = connectionsRes.ok
      ? ((await connectionsRes.json().catch(() => ({}))) as {
          connections?: Connection[];
          connectionOrder?: string[];
        })
      : {};
    const policyBody = policyRes.ok
      ? ((await policyRes.json().catch(() => ({}))) as { policy?: PurposePolicy })
      : {};
    const connections = Array.isArray(connectionsBody.connections) ? connectionsBody.connections : [];
    const connectionOrder = reconcileConnectionOrder(
      connections,
      Array.isArray(connectionsBody.connectionOrder) ? connectionsBody.connectionOrder : [],
    );
    const policy =
      policyBody.policy && typeof policyBody.policy.version === "number"
        ? policyBody.policy
        : EMPTY_POLICY;
    return {
      connections: orderConnections(connections, connectionOrder),
      policy,
      connectionOrder,
    };
  } catch (error) {
    console.warn(
      `model config read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EMPTY_SNAPSHOT;
  }
}

/**
 * Resolve the coding route for one delegation. Throws with an
 * operator-readable message when the requested connection/model/harness is
 * inadmissible — the caller surfaces this before any approval is minted.
 *
 * `requestedConnectionId`/`requestedModel` are the per-run override (the
 * composer's typed selection or the delegate tool input); absent, the
 * deploy default floor applies with a null (implicit) connection.
 */
export function resolveCodingRoute(
  snapshot: ModelConfigSnapshot,
  requested: { connectionId?: string | null; model: string; harness: string; reasoningEffort?: ReasoningEffort },
  initiator?: RunInitiatorContext,
): ApprovedRoute {
  const effort = requested.reasoningEffort;
  if (effort !== undefined && !(HARNESS_REASONING_EFFORTS[requested.harness] ?? []).includes(effort)) {
    throw new Error(`Harness "${requested.harness}" does not support reasoning effort "${effort}".`);
  }
  const effortField = effort !== undefined ? { reasoningEffort: effort } : {};
  let connectionId = requested.connectionId ?? null;
  if (connectionId === null) {
    const sole = soleReadyConnection(snapshot);
    if (sole !== null && validateConnectionModel(sole, requested.model, requested.harness) === null) {
      connectionId = sole.id;
    }
  }
  if (connectionId === null) {
    // The deployment's implicit default: egress binds the provider host of
    // the resolved model; the gateway's default BYOK credential applies.
    return {
      purpose: "coding",
      connectionId: null,
      modelId: requested.model,
      harness: requested.harness,
      policyVersion: snapshot.policy.version,
      ...effortField,
    };
  }
  const connection = snapshot.connections.find((entry) => entry.id === connectionId);
  if (!connection) {
    throw new Error(`Unknown model connection ${JSON.stringify(connectionId)}.`);
  }
  const problem = validateConnectionModel(connection, requested.model, requested.harness);
  if (problem !== null) {
    throw new Error(problem);
  }
  assertConnectionEligibleForRun(connection, initiator ?? {});
  return {
    purpose: "coding",
    connectionId: connection.id,
    modelId: requested.model,
    harness: requested.harness,
    policyVersion: snapshot.policy.version,
    ...effortField,
  };
}

/**
 * Revalidate a frozen route just before dispatch. The connection may have
 * been disabled or deleted since approval; a stale route must fail the run
 * honestly, never silently substitute another model.
 */
export function revalidateCodingRoute(snapshot: ModelConfigSnapshot, route: ApprovedRoute): string | null {
  if (route.connectionId === null) return null;
  const connection = snapshot.connections.find((entry) => entry.id === route.connectionId);
  if (!connection) {
    return "The approved model connection no longer exists.";
  }
  return validateConnectionModel(connection, route.modelId, route.harness);
}

/**
 * The Workers AI model a non-coding purpose runs on. Policy wins over the
 * purpose's deployment var; the checked-in default is the floor. `coding`
 * has no Workers AI resolution — it routes through connections.
 */
/** @public */
export function resolvePurposeModel(
  policy: PurposePolicy,
  purpose: Exclude<Purpose, "coding" | "intent" | "quality">,
  env: { ORCHESTRATOR_MODEL?: string; REVIEW_MODEL?: string; PLAN_MODEL?: string; UI_MODEL?: string },
): string {
  const PURPOSE_ENV_KEYS = {
    orchestrator: "ORCHESTRATOR_MODEL",
    automation_gate: "ORCHESTRATOR_MODEL",
    distillation: "ORCHESTRATOR_MODEL",
    review: "REVIEW_MODEL",
    plan: "PLAN_MODEL",
    ui: "UI_MODEL",
  } as const;
  const envKey = PURPOSE_ENV_KEYS[purpose];
  return policy.models[purpose] ?? env[envKey] ?? env.ORCHESTRATOR_MODEL ?? DEFAULT_ORCHESTRATOR_MODEL;
}

/** Harness names the catalog may reference — re-exported for route modules. */
/** @public */
export const CODING_HARNESSES: readonly string[] = HARNESS_NAMES;
