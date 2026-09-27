/**
 * T47 — shared auth-core types (PLAN.md §18.9).
 *
 * One auth state machine shared by the subscription harnesses (T48–T50);
 * the Worker side implements the controller, harnesses import only the
 * *type* from here so the `harness/ → shared` dependency rule holds —
 * `src/auth/` never imports from `harness/`.
 *
 * Ported from t3code's ProviderAuthFlow, trimmed to shiba:
 *   - `waiting` exists in the enum but only T50's pasted-redirect flow
 *     enters it — Claude/Codex go starting → verifying directly.
 *   - `succeeded` is set ONLY by the capability probe in verify() — a
 *     200 from a token exchange or callback delivery is never proof.
 */

export type AuthPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cleared";

export interface AuthSnapshot {
  phase: AuthPhase;
  /** Session that owns this flow; mutating methods refuse anyone else. */
  ownerSessionId: string | null;
  message?: string;
  /**
   * T50: the URL the operator must open to sign in — only while `waiting`.
   * Never present on snapshots for secret-material flows.
   */
  authorizationUrl?: string;
  /** Epoch ms the underlying credential is known-good until, if probed. */
  expiresAt?: number;
}

/**
 * An auth flow belongs to the session that started it. Other sessions may
 * read `snapshot()` but `begin`/`verify`/`clear` refuse them — one client
 * polling a dashboard must not cancel another client's sign-in.
 */
export interface ProviderAuthController {
  /** Stable per account, e.g. "claude-sub:acct1" — never the secret. */
  readonly instanceId: string;
  snapshot(): Promise<AuthSnapshot>;
  begin(ownerSessionId: string): Promise<void>;
  /** The real capability probe; sets succeeded or failed — nothing else may. */
  verify(ownerSessionId: string): Promise<AuthSnapshot>;
  /**
   * Ordered sign-out, idempotent: close admission to new runs first, stop
   * in-flight runs on this instance, then clear stored metadata. Reversed,
   * a queued or resumed run keeps using a revoked credential.
   */
  clear(ownerSessionId: string): Promise<void>;
  /**
   * T50 (pasted-redirect flows only): deliver the operator's pasted
   * `http://127.0.0.1/...` redirect URL into the flow's pending callback.
   * Valid only while `waiting`, owner-scoped, single-use per pending
   * record; the provider validates the URL against the stored
   * `state`/`redirect_uri` before anything is sent. Delivery is not
   * authentication — `verify()`'s probe still owns `succeeded`.
   */
  deliverCallback?(ownerSessionId: string, callbackUrl: string): Promise<{ message?: string }>;
}
