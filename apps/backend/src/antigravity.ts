/**
 * T50 — worker routes for the antigravity-subscription flow
 * (PLAN.md §18.12). A dedicated handler module — NOT index.ts growth —
 * because this is the one provider whose sign-in cannot complete inside
 * the deployment's trust boundary: Google redirects to a loopback
 * listener inside a container the operator's browser cannot reach.
 *
 *   GET  /api/auth/antigravity-subscription?account=<name> → snapshot
 *   POST /api/auth/antigravity-subscription/begin|verify|clear → {account}
 *   POST /api/antigravity/callback                          → {account, url}
 *
 * The callback route accepts the operator's pasted `http://127.0.0.1/…`
 * URL and hands it to the T47 controller's `deliverCallback` — owner-
 * scoped, `waiting`-phase only, single-use. Validation and delivery live
 * in the provider; this module only authenticates the caller and maps
 * errors. A delivered callback never sets `succeeded` — verify()'s probe
 * owns that.
 */
import type { Env } from "./env.js";
import {
  antigravitySubscriptionAuth,
} from "./auth/antigravity-subscription.js";
import { antigravitySubscriptionInstanceId } from "./harness/antigravity-subscription.js";
import { AuthFlowError } from "./auth/controller.js";
import { AntigravityCallbackError } from "@shiba/shared";

function authError(reason: unknown): Response {
  const status =
    reason instanceof AuthFlowError && reason.reason === "not_owner" ? 403 : 400;
  return Response.json(
    { error: reason instanceof Error ? reason.message : "Auth flow error." },
    { status },
  );
}

/** The T47 controller for the request's account (name sanitized by the helper). */
function controllerFor(env: Env, account: string) {
  return antigravitySubscriptionAuth(env, antigravitySubscriptionInstanceId({ authAccount: account }));
}

/** begin | verify | clear on the antigravity-subscription flow. */
export async function handleAntigravitySubscriptionAuth(
  request: Request,
  env: Env,
  ownerSessionId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice("/api/auth/antigravity-subscription".length).replace(/^\/+|\/+$/g, "");
  const body =
    request.method === "POST"
      ? ((await request.json().catch(() => ({}))) as { account?: unknown })
      : {};
  const accountRaw = request.method === "GET" ? url.searchParams.get("account") : body.account;
  const account = typeof accountRaw === "string" && accountRaw.trim() !== "" ? accountRaw.trim() : "default";
  const controller = controllerFor(env, account);
  try {
    if (request.method === "GET" && sub === "") {
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "begin") {
      return Response.json({ snapshot: await controller.begin(ownerSessionId) });
    }
    if (request.method === "POST" && sub === "verify") {
      return Response.json({ snapshot: await controller.verify(ownerSessionId) });
    }
    if (request.method === "POST" && sub === "clear") {
      return Response.json({ snapshot: await controller.clear(ownerSessionId) });
    }
  } catch (error) {
    return authError(error);
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}

/**
 * POST /api/antigravity/callback — the operator pastes the complete
 * `http://127.0.0.1:<port>/oauth2callback?...` URL their browser failed
 * to load; we validate it against the pending flow record and deliver it
 * into the container listener. Generic errors only — the URL details
 * stay between the operator and their container.
 */
export async function handleAntigravityCallback(
  request: Request,
  env: Env,
  ownerSessionId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/antigravity/callback") return null;
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    account?: unknown;
    url?: unknown;
  };
  const account =
    typeof body.account === "string" && body.account.trim() !== "" ? body.account.trim() : "default";
  if (typeof body.url !== "string" || body.url.trim() === "") {
    return Response.json(
      { error: "Paste the complete redirect URL from the Google sign-in page." },
      { status: 400 },
    );
  }
  const controller = controllerFor(env, account);
  if (controller.deliverCallback === undefined) {
    return Response.json({ error: "This provider does not accept callbacks." }, { status: 400 });
  }
  try {
    const result = await controller.deliverCallback(ownerSessionId, body.url.trim());
    return Response.json({ ok: true, ...(result.message !== undefined ? { message: result.message } : {}) });
  } catch (error) {
    if (error instanceof AntigravityCallbackError || error instanceof AuthFlowError) {
      return authError(error);
    }
    return Response.json({ error: "Could not deliver the sign-in response. Start sign-in again." }, { status: 400 });
  }
}
