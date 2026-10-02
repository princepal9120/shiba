/**
 * Provider module for `cursor-subscription` on the T47 shared auth core.
 * Everything account-scoped keys off the instanceId (`cursor-sub:<account>`);
 * the credential is a named Worker secret read only at the egress boundary.
 *
 * begin() does NOT write the secret: a Worker cannot mint its own secrets —
 * the operator stores their Cursor Agent API key (cursor.com settings) via
 * `wrangler secret put CURSOR_SUBSCRIPTION_TOKEN` (or `_<ACCOUNT>`) out of
 * band. begin asserts the secret is present so a flow cannot open against an
 * unprovisioned account; verify() runs the capability probe and only its
 * verdict sets `succeeded`.
 *
 * Probe: api2.cursor.sh has no authenticated GET (every GET there 404s,
 * verified) — the Cursor wire is Connect-RPC POSTs. The credential-bearing
 * call the CLI itself makes with CURSOR_API_KEY is the auth exchange,
 * `POST /auth/exchange_user_api_key` (VERIFICATION.md: the CLI stores the
 * access/refresh tokens it mints inside the container). 401 returns
 * "Invalid User API Key" — a 200 proves the key works end-to-end through
 * the same egress branch runs use.
 *
 * The package cannot reach `apps/backend/src/egress.js` (workspace
 * boundary), so the caller injects the Worker-side forwarder — same
 * function runs use, so the probe exercises the exact wire.
 */
import type { ProviderAuthController } from "@shiba/shared";
import {
  createAuthController,
  type AuthProviderHooks,
} from "./controller.js";
import type { SubscriptionForwarder } from "./claude-subscription.js";

/** Secret name an account's Cursor API key lives under. */
export function cursorSubscriptionSecretName(account: string): string {
  return account === "default" ? "CURSOR_SUBSCRIPTION_TOKEN" : `CURSOR_SUBSCRIPTION_TOKEN_${account.toUpperCase().replace(/-/g, "_")}`;
}

/** The env lookup — returns undefined rather than throwing so probes fail soft. */
export function cursorSubscriptionToken(env: unknown, account: string): string | undefined {
  const value = (env as Record<string, unknown>)[cursorSubscriptionSecretName(account)];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface AuthControllerEnv {
  AGENT_TOKENS: KVNamespace;
}

/**
 * The capability probe: ask the subscription branch to post the CLI's own
 * credential exchange — the smallest authenticated call on api2.cursor.sh.
 * A 200 proves the token works end-to-end through egress; 401/403 → the
 * real reason; anything else → unreachable/failed with the status.
 */
async function probeCursorSubscription<Env extends AuthControllerEnv>(
  env: Env,
  instanceId: string,
  forward: SubscriptionForwarder,
): Promise<{ ok: boolean; message?: string }> {
  const account = instanceId.slice("cursor-sub:".length);
  if (cursorSubscriptionToken(env, account) === undefined) {
    return { ok: false, message: `${cursorSubscriptionSecretName(account)} is not set — run \`wrangler secret put\` first.` };
  }
  const request = new Request("https://api2.cursor.sh/auth/exchange_user_api_key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  try {
    // The forwarder reads only the named secret off env; pass the same
    // object the admission gate got — the token itself is never touched here.
    const response = await forward(request, env, { params: { account } });
    if (response.status === 200) return { ok: true, message: "API key reached the Cursor API." };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `credential rejected (${response.status}) — issue a new Cursor Agent API key and re-store the secret.` };
    }
    return { ok: false, message: `probe returned ${response.status}.` };
  } catch {
    return { ok: false, message: "probe request failed." };
  }
}

/** The T47 controller for one cursor-subscription account. */
export function cursorSubscriptionAuth<Env extends AuthControllerEnv>(
  env: Env,
  instanceId: string,
  forward: SubscriptionForwarder,
): ProviderAuthController {
  const hooks: AuthProviderHooks<Env> = {
    probe: (e, id) => probeCursorSubscription(e, id, forward),
    onBegin: async (e, id) => {
      const account = id.slice("cursor-sub:".length);
      if (cursorSubscriptionToken(e, account) === undefined) {
        throw new Error(
          `${cursorSubscriptionSecretName(account)} is not set. The operator stores their Cursor Agent API key via \`wrangler secret put\`.`,
        );
      }
    },
    // closeAdmission / stopInFlight: as documented on claude-subscription —
    // the phase change itself closes admission; in-flight runs die with
    // their sandbox.
  };
  return createAuthController(env, instanceId, hooks);
}
