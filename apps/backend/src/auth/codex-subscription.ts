/**
 * T49 — provider module for `codex-subscription` on the T47 shared auth
 * core (PLAN.md §18.9/§18.11). Account identity keys on the directory
 * holding auth.json — the instanceId is `codex-sub:<effectiveHomePath>`
 * (the shadow home for named accounts, the shared home for "default"), so
 * `clear` on an overlay revokes only that account and never touches the
 * shared one. The credential (auth.json contents) is a named Worker
 * secret read only at the egress boundary.
 *
 * begin() does NOT write the secret: a Worker cannot mint its own secrets
 * — the operator runs `codex login` on their own machine and stores the
 * resulting file via `wrangler secret put CODEX_SUBSCRIPTION_AUTH_JSON`
 * (or `_<ACCOUNT>`). begin asserts the secret parses so a flow cannot
 * open against an unprovisioned account; verify() runs the capability
 * probe — a real `GET /backend-api/wham/usage` through the same egress
 * branch runs use — and only its verdict sets `succeeded`.
 */
import type { ProviderAuthController } from "@shiba/shared";
import { codexSubscriptionAccountFromInstanceId } from "../harness/codex-subscription.js";
import {
  createAuthController,
  type AuthProviderHooks,
} from "./controller.js";
import { forwardCodexSubscription, parseCodexAuthJson, type EgressEnv } from "../egress.js";

/** Secret name an account's auth.json contents live under. */
export function codexSubscriptionSecretName(account: string): string {
  return account === "default" ? "CODEX_SUBSCRIPTION_AUTH_JSON" : `CODEX_SUBSCRIPTION_AUTH_JSON_${account.toUpperCase().replace(/-/g, "_")}`;
}

/** The env lookup — returns undefined rather than throwing so probes fail soft. */
export function codexSubscriptionAuthJson(env: unknown, account: string): string | undefined {
  const value = (env as Record<string, unknown>)[codexSubscriptionSecretName(account)];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface AuthControllerEnv {
  AGENT_TOKENS: KVNamespace;
}

/**
 * The capability probe: ask the subscription branch for the account's
 * rate-limit surface — the smallest credential-bearing read the CLI's
 * account surface performs. 200 proves the stored auth.json works
 * end-to-end through egress; 401/403 → the real reason.
 */
async function probeCodexSubscription<Env extends AuthControllerEnv>(
  env: Env,
  instanceId: string,
): Promise<{ ok: boolean; message?: string }> {
  const account = codexSubscriptionAccountFromInstanceId(instanceId);
  const raw = codexSubscriptionAuthJson(env, account);
  if (raw === undefined) {
    return { ok: false, message: `${codexSubscriptionSecretName(account)} is not set — run \`wrangler secret put\` first.` };
  }
  if (parseCodexAuthJson(raw) === null) {
    return { ok: false, message: `${codexSubscriptionSecretName(account)} is not a valid auth.json — store the file contents verbatim.` };
  }
  const request = new Request("https://chatgpt.com/backend-api/wham/usage", { method: "GET" });
  try {
    const response = await forwardCodexSubscription(request, env as unknown as EgressEnv, { params: { account } });
    if (response.status === 200) return { ok: true, message: "auth.json reached the ChatGPT backend." };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `credential rejected (${response.status}) — renew it with \`codex login\` and re-store the secret.` };
    }
    return { ok: false, message: `probe returned ${response.status}.` };
  } catch {
    return { ok: false, message: "probe request failed." };
  }
}

/** The T47 controller for one codex-subscription account. */
export function codexSubscriptionAuth<Env extends AuthControllerEnv>(
  env: Env,
  instanceId: string,
): ProviderAuthController {
  const hooks: AuthProviderHooks<Env> = {
    probe: probeCodexSubscription,
    onBegin: async (e, id) => {
      const account = codexSubscriptionAccountFromInstanceId(id);
      const raw = codexSubscriptionAuthJson(e, account);
      if (raw === undefined) {
        throw new Error(
          `${codexSubscriptionSecretName(account)} is not set. The operator runs \`codex login\` and stores the resulting auth.json via \`wrangler secret put\`.`,
        );
      }
      if (parseCodexAuthJson(raw) === null) {
        throw new Error(`${codexSubscriptionSecretName(account)} is not a valid auth.json — store the file contents verbatim.`);
      }
    },
    // closeAdmission / stopInFlight: as documented on claude-subscription —
    // the phase change itself closes admission; in-flight runs die with
    // their sandbox.
  };
  return createAuthController(env, instanceId, hooks);
}
