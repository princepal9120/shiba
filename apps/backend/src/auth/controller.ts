/**
 * T47 — shared auth core: the state machine T48–T50 hang provider-specific
 * credential mechanics on (PLAN.md §18.9). Types live in @shiba/shared so
 * harnesses read `ProviderAuthController` without importing the Worker.
 *
 * Three ported t3code rules, load-bearing:
 *
 * 1. Ownership — a flow belongs to the session that began it. Every
 *    mutating method checks `ownerSessionId` against the stored owner;
 *    other sessions read `snapshot()` but cannot advance or cancel.
 * 2. HTTP success ≠ auth success — only `verify()`'s capability probe
 *    (a dedicated auth-probe run, supplied per provider) may set
 *    `succeeded`. `begin` never does.
 * 3. Sign-out order — `clear()` runs provider `closeAdmission` (the harness
 *    leaves `succeeded` ⇒ unselectable via T43's capability check), then
 *    `stopInFlight` (abort runs on this instance via the existing cancel
 *    path), then wipes the stored record. Idempotent; safe mid-flight.
 *
 * Storage: flow state lives in AGENT_TOKENS KV under `auth_flow_<id>` —
 * state is metadata, never the credential. The credential itself is a
 * named Worker secret per account (declared in env.ts + both deploy
 * configs by the provider task), read only at the egress boundary.
 */
import {
  type AuthPhase,
  type AuthSnapshot,
  type ProviderAuthController,
} from "@shiba/shared";
import { redactSecrets } from "../security.js";

/** Provider-specific seams the shared machine calls into. */
export interface AuthProviderHooks<Env> {
  /**
   * The real capability probe — for subscription providers a dedicated
   * auth-probe run (minimal sandbox invocation, init-only status path;
   * never a command that opens a session, starts MCP, or launches a
   * browser). Its verdict alone sets `succeeded`.
   */
  probe(env: Env, instanceId: string): Promise<{ ok: boolean; message?: string; expiresAt?: number }>;
  /**
   * Provider-side begin work (e.g. record the pasted credential into the
   * secret store). Return `{ wait: "message" }` to enter `waiting` — only
   * flows that block on an out-of-band artifact (T50's pasted redirect)
   * do so; token providers omit the field and go straight to verifying.
   */
  onBegin?(env: Env, instanceId: string, ownerSessionId: string): Promise<{ wait?: string } | void>;
  /** Clear step 1: close admission — the harness becomes unselectable. */
  closeAdmission?(env: Env, instanceId: string): Promise<void>;
  /** Clear step 2: stop in-flight runs on this instance (existing cancel path). */
  stopInFlight?(env: Env, instanceId: string): Promise<void>;
  /** Clear step 3 (optional): provider-side teardown beyond the state record. */
  onCleared?(env: Env, instanceId: string): Promise<void>;
}

export class AuthFlowError extends Error {
  readonly code = "auth_flow";
  constructor(
    readonly reason: "not_owner" | "invalid_phase" | "store_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AuthFlowError";
  }
}

interface FlowRecord {
  phase: AuthPhase;
  ownerSessionId: string | null;
  message?: string;
  expiresAt?: number;
}

/** The phases from which a new begin() is legal. */
const BEGINNABLE: readonly AuthPhase[] = ["idle", "cleared", "failed", "succeeded"];
/** Mutating methods allowed from these phases. */
const ACTIVE: readonly AuthPhase[] = ["starting", "waiting", "verifying", "succeeded", "failed"];

const FLOW_PREFIX = "auth_flow_";

interface AuthKvEnv {
  AGENT_TOKENS: KVNamespace;
}

async function readFlow<Env extends AuthKvEnv>(env: Env, instanceId: string): Promise<FlowRecord> {
  let raw: string | null;
  try {
    raw = await env.AGENT_TOKENS.get(`${FLOW_PREFIX}${instanceId}`, { type: "text" });
  } catch (error) {
    console.warn(`auth: KV get failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    throw new AuthFlowError("store_unavailable", "auth state store is unreachable.");
  }
  if (raw === null) return { phase: "idle", ownerSessionId: null };
  try {
    const record = JSON.parse(raw) as FlowRecord;
    return typeof record.phase === "string" ? record : { phase: "idle", ownerSessionId: null };
  } catch {
    return { phase: "idle", ownerSessionId: null };
  }
}

async function writeFlow<Env extends AuthKvEnv>(env: Env, instanceId: string, record: FlowRecord): Promise<void> {
  try {
    await env.AGENT_TOKENS.put(`${FLOW_PREFIX}${instanceId}`, JSON.stringify(record));
  } catch (error) {
    console.warn(`auth: KV put failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    throw new AuthFlowError("store_unavailable", "auth state store is unreachable.");
  }
}

/**
 * Assert `sessionId` owns the flow. A flow with no owner (idle) may be
 * claimed by begin only — mutating methods on an owned flow refuse
 * everyone else, so a dashboard poll can never cancel a sign-in.
 */
function requireOwner(record: FlowRecord, sessionId: string, verb: string): void {
  if (record.ownerSessionId !== null && record.ownerSessionId !== sessionId) {
    throw new AuthFlowError(
      "not_owner",
      `cannot ${verb}: this auth flow belongs to a different session.`,
    );
  }
}

/**
 * Build the shared controller for one provider instance. `instanceId` is
 * stable per account (`"claude-sub:acct1"`) — it appears in records and
 * logs; the credential never does.
 */
export function createAuthController<Env extends AuthKvEnv>(
  env: Env,
  instanceId: string,
  hooks: AuthProviderHooks<Env>,
): ProviderAuthController {
  const snapshot = async (): Promise<AuthSnapshot> => {
    const record = await readFlow(env, instanceId);
    return {
      phase: record.phase,
      ownerSessionId: record.ownerSessionId,
      ...(record.message !== undefined ? { message: record.message } : {}),
      ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    };
  };

  return {
    instanceId,
    snapshot,

    async begin(ownerSessionId: string): Promise<void> {
      const record = await readFlow(env, instanceId);
      // A live flow owned by another session is untouchable.
      if (!BEGINNABLE.includes(record.phase)) {
        requireOwner(record, ownerSessionId, "begin");
        if (record.phase === "verifying") {
          throw new AuthFlowError("invalid_phase", "a verification is already in flight.");
        }
      }
      requireOwner(record, ownerSessionId, "begin");
      const started: FlowRecord = { phase: "starting", ownerSessionId };
      await writeFlow(env, instanceId, started);
      // Provider begin work (e.g. record the credential) may elect to wait
      // for an out-of-band artifact — only T50's flow returns `wait`.
      const outcome = await hooks.onBegin?.(env, instanceId, ownerSessionId);
      if (outcome?.wait !== undefined) {
        await writeFlow(env, instanceId, { phase: "waiting", ownerSessionId, message: outcome.wait });
      }
    },

    async verify(ownerSessionId: string): Promise<AuthSnapshot> {
      const record = await readFlow(env, instanceId);
      requireOwner(record, ownerSessionId, "verify");
      if (record.phase === "idle" || record.phase === "cleared") {
        throw new AuthFlowError("invalid_phase", "nothing to verify — begin() first.");
      }
      await writeFlow(env, instanceId, { ...record, phase: "verifying" });
      try {
        const verdict = await hooks.probe(env, instanceId);
        const next: FlowRecord = verdict.ok
          ? {
              phase: "succeeded", ownerSessionId,
              ...(verdict.message !== undefined ? { message: verdict.message } : {}),
              ...(verdict.expiresAt !== undefined ? { expiresAt: verdict.expiresAt } : {}),
            }
          : {
              phase: "failed", ownerSessionId,
              message: verdict.message ?? "capability probe failed.",
            };
        await writeFlow(env, instanceId, next);
        return {
          phase: next.phase, ownerSessionId: next.ownerSessionId,
          ...(next.message !== undefined ? { message: next.message } : {}),
          ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {}),
        };
      } catch (error) {
        const message = `probe threw: ${error instanceof Error ? error.message : String(error)}`;
        await writeFlow(env, instanceId, { phase: "failed", ownerSessionId, message });
        return { phase: "failed", ownerSessionId, message };
      }
    },

    async clear(ownerSessionId: string): Promise<void> {
      const record = await readFlow(env, instanceId);
      requireOwner(record, ownerSessionId, "clear");
      if (record.phase === "idle" || record.phase === "cleared") {
        return; // idempotent — a second clear is a no-op
      }
      if (!ACTIVE.includes(record.phase)) return;
      // Ordered teardown: admission closes BEFORE in-flight runs are
      // stopped, and metadata clears LAST — a queued run must never find
      // a credential whose flow already claims to be gone.
      await hooks.closeAdmission?.(env, instanceId);
      await hooks.stopInFlight?.(env, instanceId);
      await writeFlow(env, instanceId, { phase: "cleared", ownerSessionId: null });
      await hooks.onCleared?.(env, instanceId);
    },
  };
}
