/**
 * Provider module for `devin-subscription` on the T47 shared auth core.
 * Everything account-scoped keys off the instanceId (`devin-sub:<account>`);
 * the credential is a named Worker secret read only at the egress boundary.
 *
 * begin() does NOT write the secret: a Worker cannot mint its own secrets —
 * the operator stores their Devin API key/session token via
 * `wrangler secret put DEVIN_SUBSCRIPTION_TOKEN` (or `_<ACCOUNT>`) out of
 * band. begin asserts the secret is present so a flow cannot open against an
 * unprovisioned account; verify() runs the capability probe — a real
 * `GET /v3/self` on api.devin.ai through the same egress branch runs use —
 * and only its verdict sets `succeeded`.
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

/** Secret name an account's Devin API key/session token lives under. */
export function devinSubscriptionSecretName(account: string): string {
  return account === "default" ? "DEVIN_SUBSCRIPTION_TOKEN" : `DEVIN_SUBSCRIPTION_TOKEN_${account.toUpperCase().replace(/-/g, "_")}`;
}

/** The env lookup — returns undefined rather than throwing so probes fail soft. */
export function devinSubscriptionToken(env: unknown, account: string): string | undefined {
  const value = (env as Record<string, unknown>)[devinSubscriptionSecretName(account)];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface AuthControllerEnv {
  AGENT_TOKENS: KVNamespace;
}

/**
 * The capability probe: ask the subscription branch for `/v3/self` — the
 * smallest credential-bearing read on the Devin control plane (verified
 * 200 with `Authorization: Bearer <key>`). A 200 proves the token works
 * end-to-end through egress; 401/403 → the real reason; anything else →
 * unreachable/failed with the status.
 */
async function probeDevinSubscription<Env extends AuthControllerEnv>(
  env: Env,
  instanceId: string,
  forward: SubscriptionForwarder,
): Promise<{ ok: boolean; message?: string }> {
  const account = instanceId.slice("devin-sub:".length);
  if (devinSubscriptionToken(env, account) === undefined) {
    return { ok: false, message: `${devinSubscriptionSecretName(account)} is not set — run \`wrangler secret put\` first.` };
  }
  const request = new Request("https://api.devin.ai/v3/self", { method: "GET" });
  try {
    // The forwarder reads only the named secret off env; pass the same
    // object the admission gate got — the token itself is never touched here.
    const response = await forward(request, env, { params: { account } });
    if (response.status === 200) return { ok: true, message: "API key reached the Devin API." };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `credential rejected (${response.status}) — renew it with \`devin auth login\` and re-store the secret.` };
    }
    return { ok: false, message: `probe returned ${response.status}.` };
  } catch {
    return { ok: false, message: "probe request failed." };
  }
}

/** The T47 controller for one devin-subscription account. */
export function devinSubscriptionAuth<Env extends AuthControllerEnv>(
  env: Env,
  instanceId: string,
  forward: SubscriptionForwarder,
): ProviderAuthController {
  const hooks: AuthProviderHooks<Env> = {
    probe: (e, id) => probeDevinSubscription(e, id, forward),
    onBegin: async (e, id) => {
      const account = id.slice("devin-sub:".length);
      if (devinSubscriptionToken(e, account) === undefined) {
        throw new Error(
          `${devinSubscriptionSecretName(account)} is not set. The operator runs \`devin auth login\` and stores the resulting API key via \`wrangler secret put\`.`,
        );
      }
    },
    // closeAdmission / stopInFlight: as documented on claude-subscription —
    // the phase change itself closes admission; in-flight runs die with
    // their sandbox.
  };
  return createAuthController(env, instanceId, hooks);
}
