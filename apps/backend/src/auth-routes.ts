/**
 * `/api/auth/*` + `/api/antigravity/callback` — operator surfaces for the
 * subscription-auth flows (T48–T50). Each route is dark unless its
 * SHIBA_*_SUBSCRIPTION env flag is "1"; the credential itself is only ever
 * provisioned via `wrangler secret put`, never through this API. Extracted
 * from index.ts.
 */
import { claudeSubscriptionAuth, codexSubscriptionAuth, cursorSubscriptionAuth, devinSubscriptionAuth, AuthFlowError } from "@shiba/auth";
import { handleAntigravityCallback, handleAntigravitySubscriptionAuth } from "./antigravity.js";
import type { Env } from "./env.js";
import { forwardClaudeSubscription, forwardCodexSubscription, forwardCursorSubscription, forwardDevinSubscription, type EgressEnv } from "./egress.js";
import { codexSubscriptionInstanceId } from "./harness/codex-subscription.js";
import { resolveUserId } from "./request-auth.js";

const authError = (reason: unknown) =>
  Response.json(
    { error: reason instanceof Error ? reason.message : "Auth flow error." },
    { status: reason instanceof AuthFlowError && reason.reason === "not_owner" ? 403 : 400 },
  );

function accountParam(request: Request, url: URL, body: { account?: unknown }): string {
  const raw = request.method === "GET" ? url.searchParams.get("account") : body.account;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "default";
}

/**
 * T48: operator surface for the claude-subscription auth flow (T47
 * controller). Routes:
 *   GET  /api/auth/claude-subscription?account=<name>  → snapshot
 *   POST /api/auth/claude-subscription/begin           → {account} → begin()
 *   POST /api/auth/claude-subscription/verify          → {account} → verify()
 *   POST /api/auth/claude-subscription/clear           → {account} → clear()
 * The caller's Access identity becomes the ownerSessionId — only the
 * operator who began a flow may verify or clear it (T47 rule).
 */
async function handleClaudeSubscriptionAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice("/api/auth/claude-subscription".length).replace(/^\/+|\/+$/g, "");
  const ownerSessionId = (await resolveUserId(request, env)) ?? "default";
  const body =
    request.method === "POST"
      ? ((await request.json().catch(() => ({}))) as { account?: unknown })
      : {};
  const account = accountParam(request, url, body);
  const controller = claudeSubscriptionAuth(env, `claude-sub:${account}`, (request, e, ctx) =>
    forwardClaudeSubscription(request, e as EgressEnv, ctx),
  );
  try {
    if (request.method === "GET" && sub === "") {
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "begin") {
      await controller.begin(ownerSessionId);
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "verify") {
      return Response.json({ snapshot: await controller.verify(ownerSessionId) });
    }
    if (request.method === "POST" && sub === "clear") {
      await controller.clear(ownerSessionId);
      return Response.json({ snapshot: await controller.snapshot() });
    }
  } catch (error) {
    return authError(error);
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}

/**
 * T49: operator surface for the codex-subscription auth flow (T47
 * controller). Same verbs as claude-subscription; the instanceId keys on
 * the auth.json-holding directory (`codex-sub:<effectiveHomePath>`) so a
 * named account's `clear` revokes only its shadow overlay, never the
 * shared CODEX_HOME or a sibling account (§18.11).
 *   GET  /api/auth/codex-subscription?account=<name>  → snapshot
 *   POST /api/auth/codex-subscription/begin|verify|clear  → {account}
 */
async function handleCodexSubscriptionAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice("/api/auth/codex-subscription".length).replace(/^\/+|\/+$/g, "");
  const ownerSessionId = (await resolveUserId(request, env)) ?? "default";
  const body =
    request.method === "POST"
      ? ((await request.json().catch(() => ({}))) as { account?: unknown })
      : {};
  const account = accountParam(request, url, body);
  const controller = codexSubscriptionAuth(env, codexSubscriptionInstanceId({ authAccount: account }), (request, e, ctx) =>
    forwardCodexSubscription(request, e as EgressEnv, ctx),
  );
  try {
    if (request.method === "GET" && sub === "") {
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "begin") {
      await controller.begin(ownerSessionId);
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "verify") {
      return Response.json({ snapshot: await controller.verify(ownerSessionId) });
    }
    if (request.method === "POST" && sub === "clear") {
      await controller.clear(ownerSessionId);
      return Response.json({ snapshot: await controller.snapshot() });
    }
  } catch (error) {
    return authError(error);
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}

/**
 * Operator surface for the cursor-subscription auth flow (T47
 * controller). Same verbs as claude-subscription; the instanceId keys on
 * the account (`cursor-sub:<account>`).
 *   GET  /api/auth/cursor-subscription?account=<name>  → snapshot
 *   POST /api/auth/cursor-subscription/begin|verify|clear  → {account}
 */
async function handleCursorSubscriptionAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice("/api/auth/cursor-subscription".length).replace(/^\/+|\/+$/g, "");
  const ownerSessionId = (await resolveUserId(request, env)) ?? "default";
  const body =
    request.method === "POST"
      ? ((await request.json().catch(() => ({}))) as { account?: unknown })
      : {};
  const account = accountParam(request, url, body);
  const controller = cursorSubscriptionAuth(env, `cursor-sub:${account}`, (request, e, ctx) =>
    forwardCursorSubscription(request, e as EgressEnv, ctx),
  );
  try {
    if (request.method === "GET" && sub === "") {
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "begin") {
      await controller.begin(ownerSessionId);
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "verify") {
      return Response.json({ snapshot: await controller.verify(ownerSessionId) });
    }
    if (request.method === "POST" && sub === "clear") {
      await controller.clear(ownerSessionId);
      return Response.json({ snapshot: await controller.snapshot() });
    }
  } catch (error) {
    return authError(error);
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}

/**
 * Operator surface for the devin-subscription auth flow (T47
 * controller). Same verbs as claude-subscription; the instanceId keys on
 * the account (`devin-sub:<account>`).
 *   GET  /api/auth/devin-subscription?account=<name>  → snapshot
 *   POST /api/auth/devin-subscription/begin|verify|clear  → {account}
 */
async function handleDevinSubscriptionAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice("/api/auth/devin-subscription".length).replace(/^\/+|\/+$/g, "");
  const ownerSessionId = (await resolveUserId(request, env)) ?? "default";
  const body =
    request.method === "POST"
      ? ((await request.json().catch(() => ({}))) as { account?: unknown })
      : {};
  const account = accountParam(request, url, body);
  const controller = devinSubscriptionAuth(env, `devin-sub:${account}`, (request, e, ctx) =>
    forwardDevinSubscription(request, e as EgressEnv, ctx),
  );
  try {
    if (request.method === "GET" && sub === "") {
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "begin") {
      await controller.begin(ownerSessionId);
      return Response.json({ snapshot: await controller.snapshot() });
    }
    if (request.method === "POST" && sub === "verify") {
      return Response.json({ snapshot: await controller.verify(ownerSessionId) });
    }
    if (request.method === "POST" && sub === "clear") {
      await controller.clear(ownerSessionId);
      return Response.json({ snapshot: await controller.snapshot() });
    }
  } catch (error) {
    return authError(error);
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}

/**
 * Dispatch for the subscription-auth surface: `/api/auth/*` flows and the
 * antigravity pasted-redirect callback. Returns null when the path is not
 * in this surface.
 */
export async function handleSubscriptionAuth(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/claude-subscription" || url.pathname.startsWith("/api/auth/claude-subscription/")) {
    if (env.SHIBA_CLAUDE_SUBSCRIPTION !== "1") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return handleClaudeSubscriptionAuth(request, env);
  }
  if (url.pathname === "/api/auth/codex-subscription" || url.pathname.startsWith("/api/auth/codex-subscription/")) {
    if (env.SHIBA_CODEX_SUBSCRIPTION !== "1") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return handleCodexSubscriptionAuth(request, env);
  }
  if (url.pathname === "/api/auth/cursor-subscription" || url.pathname.startsWith("/api/auth/cursor-subscription/")) {
    if (env.SHIBA_CURSOR_SUBSCRIPTION !== "1") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return handleCursorSubscriptionAuth(request, env);
  }
  if (url.pathname === "/api/auth/devin-subscription" || url.pathname.startsWith("/api/auth/devin-subscription/")) {
    if (env.SHIBA_DEVIN_SUBSCRIPTION !== "1") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return handleDevinSubscriptionAuth(request, env);
  }
  // T50: OAuth sign-in flow + the pasted-redirect callback (§18.12) —
  // handlers live in src/antigravity.ts.
  if (url.pathname === "/api/auth/antigravity-subscription" || url.pathname.startsWith("/api/auth/antigravity-subscription/")) {
    if (env.SHIBA_ANTIGRAVITY_SUBSCRIPTION !== "1") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return handleAntigravitySubscriptionAuth(request, env, (await resolveUserId(request, env)) ?? "default");
  }
  if (url.pathname === "/api/antigravity/callback") {
    if (env.SHIBA_ANTIGRAVITY_SUBSCRIPTION !== "1") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    return handleAntigravityCallback(request, env, (await resolveUserId(request, env)) ?? "default");
  }
  return null;
}
