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
import type { Env } from "./env.js";
import { HARNESS_NAMES } from "./harness/index.js";
import { modelConfigStub } from "./model-config-do.js";
import {
  EMPTY_POLICY,
  validateConnectionModel,
  type ApprovedRoute,
  type Connection,
  type Purpose,
  type PurposePolicy,
} from "./model-connections.js";
import { DEFAULT_ORCHESTRATOR_MODEL } from "./session-distill.js";

export interface ModelConfigSnapshot {
  connections: Connection[];
  policy: PurposePolicy;
}

const EMPTY_SNAPSHOT: ModelConfigSnapshot = { connections: [], policy: EMPTY_POLICY };

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
      ? ((await connectionsRes.json().catch(() => ({}))) as { connections?: Connection[] })
      : {};
    const policyBody = policyRes.ok
      ? ((await policyRes.json().catch(() => ({}))) as { policy?: PurposePolicy })
      : {};
    return {
      connections: Array.isArray(connectionsBody.connections) ? connectionsBody.connections : [],
      policy:
        policyBody.policy && typeof policyBody.policy.version === "number"
          ? policyBody.policy
          : EMPTY_POLICY,
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
  requested: { connectionId?: string | null; model: string; harness: string },
): ApprovedRoute {
  const connectionId = requested.connectionId ?? null;
  if (connectionId === null) {
    // The deployment's implicit default: egress binds the provider host of
    // the resolved model; the gateway's default BYOK credential applies.
    return {
      purpose: "coding",
      connectionId: null,
      modelId: requested.model,
      harness: requested.harness,
      policyVersion: snapshot.policy.version,
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
  return {
    purpose: "coding",
    connectionId: connection.id,
    modelId: requested.model,
    harness: requested.harness,
    policyVersion: snapshot.policy.version,
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
 * deployment var; the checked-in default is the floor. `coding` has no
 * Workers AI resolution — it routes through connections.
 */
export function resolvePurposeModel(
  policy: PurposePolicy,
  purpose: Exclude<Purpose, "coding" | "intent" | "quality">,
  env: Pick<Env, "ORCHESTRATOR_MODEL">,
): string {
  return policy.models[purpose] ?? env.ORCHESTRATOR_MODEL ?? DEFAULT_ORCHESTRATOR_MODEL;
}

/** Harness names the catalog may reference — re-exported for route modules. */
export const CODING_HARNESSES: readonly string[] = HARNESS_NAMES;
