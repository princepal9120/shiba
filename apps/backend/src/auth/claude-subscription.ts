/**
 * T48 — provider module for `claude-subscription` on the T47 shared auth
 * core (PLAN.md §18.9/§18.10). Everything account-scoped keys off the
 * instanceId (`claude-sub:<account>`); the credential is a named Worker
 * secret read only at the egress boundary.
 *
 * begin() does NOT write the secret: a Worker cannot mint its own secrets
 * — the operator runs `wrangler secret put CLAUDE_SUBSCRIPTION_TOKEN`
 * (or `_<ACCOUNT>`) out of band. begin asserts the secret is present so a
 * flow cannot open against an unprovisioned account; verify() runs the
 * capability probe — a real `GET /v1/models` through the same egress
 * branch runs use — and only its verdict sets `succeeded`.
 *
 * Deviation recorded in VERIFICATION.md: §18.10 names a sandboxed CLI
 * status invocation as the probe; the pinned claude CLI could not be
 * observed on this machine, so the probe exercises the credential on the
 * exact wire a run uses instead — a stored secret is still never proof.
 */
import type { ProviderAuthController } from "@shiba/shared";
import {
  createAuthController,
  type AuthProviderHooks,
} from "./controller.js";
import { forwardClaudeSubscription, type EgressEnv } from "../egress.js";

/** Secret name an account's setup-token lives under. */
export function claudeSubscriptionSecretName(account: string): string {
  return account === "default" ? "CLAUDE_SUBSCRIPTION_TOKEN" : `CLAUDE_SUBSCRIPTION_TOKEN_${account.toUpperCase().replace(/-/g, "_")}`;
}

/** The env lookup — returns undefined rather than throwing so probes fail soft. */
export function claudeSubscriptionToken(env: unknown, account: string): string | undefined {
  const value = (env as Record<string, unknown>)[claudeSubscriptionSecretName(account)];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface AuthControllerEnv {
  AGENT_TOKENS: KVNamespace;
}

/**
 * The capability probe: ask the subscription branch to fetch /v1/models —
 * the smallest credential-bearing read the CLI's model surface performs.
 * A 200 proves the token works end-to-end through egress; 401/403 → the
 * real reason; anything else → unreachable/failed with the status.
 */
async function probeClaudeSubscription<Env extends AuthControllerEnv>(
  env: Env,
  instanceId: string,
): Promise<{ ok: boolean; message?: string }> {
  const account = instanceId.slice("claude-sub:".length);
  if (claudeSubscriptionToken(env, account) === undefined) {
    return { ok: false, message: `${claudeSubscriptionSecretName(account)} is not set — run \`wrangler secret put\` first.` };
  }
  const request = new Request("https://api.anthropic.com/v1/models?limit=1", { method: "GET" });
  try {
    // The forwarder reads only the named secret off env; pass the same
    // object the admission gate got — the token itself is never touched here.
    const response = await forwardClaudeSubscription(request, env as unknown as EgressEnv, { params: { account } });
    if (response.status === 200) return { ok: true, message: "setup-token reached the API." };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `credential rejected (${response.status}) — renew it with \`claude setup-token\` and re-store the secret.` };
    }
    return { ok: false, message: `probe returned ${response.status}.` };
  } catch {
    return { ok: false, message: "probe request failed." };
  }
}

/** The T47 controller for one claude-subscription account. */
export function claudeSubscriptionAuth<Env extends AuthControllerEnv>(
  env: Env,
  instanceId: string,
): ProviderAuthController {
  const hooks: AuthProviderHooks<Env> = {
    probe: probeClaudeSubscription,
    onBegin: async (e, id) => {
      const account = id.slice("claude-sub:".length);
      if (claudeSubscriptionToken(e, account) === undefined) {
        throw new Error(
          `${claudeSubscriptionSecretName(account)} is not set. The operator runs \`claude setup-token\` and stores the printed token via \`wrangler secret put\`.`,
        );
      }
    },
    // closeAdmission: the phase leaving `succeeded` is itself the T43
    // unselectable signal — the admission gate reads the controller, so no
    // extra teardown is needed before stopInFlight.
    // stopInFlight: active runs on this instance die with their sandbox —
    // the run-cancel path is owned by the orchestrator; the phase change
    // already refuses every subsequent run for this account.
  };
  return createAuthController(env, instanceId, hooks);
}
