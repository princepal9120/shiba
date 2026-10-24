/**
 * Container egress handlers. They run in the Worker, not the container, so
 * credentials are attached here and never reach repository processes.
 *
 * Kept out of sandbox.ts: that module imports the Sandbox SDK, which pulls
 * `cloudflare:` builtins and cannot be loaded by the node test runner.
 */
import type { Env as WorkerEnv } from "./env.js";
import { chatGptAuthStub } from "./chatgpt-auth-do.js";
import { userProviderOAuthStub } from "./user-provider-oauth-do.js";
import { parseResolvedCodexCredential, resolveCodexSubscriptionAuthJson } from "./codex-subscription-credential.js";
import { sanitizeContainerHeaders, stripCredentialParams } from "./provider-gateway.js";
import { getDecryptedOrgModelKey } from "./org-model-keys-store.js";
import { kindForHost, readProviderSecretForOrg, type UserSecretKind } from "./user-provider-keys.js";

export type EgressEnv = Pick<
  WorkerEnv,
  | "AI"
  | "GATEWAY_ID"
  | "AI_GATEWAY_TOKEN"
  | "GITHUB_TOKEN"
  | "CLAUDE_SUBSCRIPTION_TOKEN"
  | "CODEX_SUBSCRIPTION_AUTH_JSON"
  | "CURSOR_SUBSCRIPTION_TOKEN"
  | "MODEL_CREDENTIAL_KEY"
  | "SHIBA_SINGLE_USER"
  | "AGENT_AUDIT"
  | "ChatGptAuth"
  | "UserProviderOAuth"
> & {
  /** Present when a user has saved a provider key. */
  AGENT_TOKENS?: WorkerEnv["AGENT_TOKENS"];
};

/**
 * Handler ctx carries the per-run params passed to `setOutboundByHost`. The
 * SDK types `params` as `unknown`, so the shape is narrowed at the use site.
 */
export interface OutboundHandlerCtx {
  params?: unknown;
  orgId?: string;
}

function approvedPath(ctx?: OutboundHandlerCtx): string | undefined {
  const params = ctx?.params;
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as { allowedPath?: unknown }).allowedPath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function applyUserKey(headers: Headers, kind: UserSecretKind, secret: string): void {
  if (kind === "google") {
    headers.set("x-goog-api-key", secret);
    return;
  }
  headers.set("Authorization", `Bearer ${secret}`);
  if (kind === "claude-setup") {
    headers.set("anthropic-beta", "oauth-2025-04-20");
    headers.set("anthropic-version", "2023-06-01");
  }
}

/** Saved user key: call the provider host directly. The gateway is not involved. */
async function fetchWithUserKey(
  request: Request,
  host: string,
  kind: UserSecretKind,
  secret: string,
): Promise<Response> {
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.hostname !== host) {
    return new Response("Invalid provider destination.", { status: 403 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  applyUserKey(headers, kind, secret);
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    return new Response("Provider request failed.", { status: 502 });
  }
}

function outboundHeaders(request: Request): Headers {
  const headers = sanitizeContainerHeaders(request.headers);
  // Gateway controls and credentials must not be chosen by repository code.
  for (const name of [...headers.keys()]) {
    if (name.startsWith("cf-aig-")) headers.delete(name);
  }
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return headers;
}

/**
 * The AI Gateway provider slug behind each API host. Adding a harness (T22)
 * means adding an entry here, not a new mechanism.
 */
export const GATEWAY_PROVIDERS: Record<string, string> = {
  "generativelanguage.googleapis.com": "google-ai-studio",
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
  "api.x.ai": "grok",
  // OpenCode Go rides the gateway as a configured custom provider slug
  // (spec MODEL-CONNECTIONS-ARCHITECTURE.md §3). The slug names the gateway
  // custom provider holding the Go API key as BYOK.
  "opencode.ai": "opencode-go",
};

async function forwardProvider(
  request: Request,
  env: EgressEnv,
  host: string,
  orgId?: string,
): Promise<Response> {
  const source = new URL(request.url);
  if (source.protocol !== "https:" || source.hostname !== host) {
    return new Response("Invalid provider destination.", { status: 403 });
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method not allowed.", { status: 405 });
  }
  const kind = kindForHost(host);
  if (kind) {
    const secret = await readProviderSecretForOrg(env, orgId, kind);
    if (secret) return fetchWithUserKey(request, host, kind, secret);
  }
  const slug = GATEWAY_PROVIDERS[host];
  if (!slug) {
    if (host === "api.deepseek.com") {
      return new Response("No saved key for this provider. Paste one on the Providers page.", { status: 503 });
    }
    return new Response("Invalid provider destination.", { status: 403 });
  }
  try {
    // getUrl resolves the account from the binding; no account-id var or public callback.
    const base = await env.AI.gateway(env.GATEWAY_ID || "default").getUrl(slug);
    const target = new URL(base);
    target.pathname = `${target.pathname.replace(/\/+$/, "")}${source.pathname}`;
    target.search = stripCredentialParams(source.search);
    const headers = outboundHeaders(request);
    if (env.AI_GATEWAY_TOKEN) headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`);

    // If org has configured a native API key for this provider, inject its header.
    if (orgId && env.AGENT_AUDIT) {
      if (host === "api.anthropic.com") {
        const key = await getDecryptedOrgModelKey(env, orgId, "anthropic");
        if (key) headers.set("x-api-key", key);
      } else if (host === "api.openai.com") {
        const key = await getDecryptedOrgModelKey(env, orgId, "openai");
        if (key) headers.set("authorization", `Bearer ${key}`);
      } else if (host === "api.x.ai") {
        const key = await getDecryptedOrgModelKey(env, orgId, "xai");
        if (key) headers.set("authorization", `Bearer ${key}`);
      } else if (host === "generativelanguage.googleapis.com") {
        const key = await getDecryptedOrgModelKey(env, orgId, "google");
        if (key) headers.set("x-goog-api-key", key);
      }
    }

    // The gateway injects its stored BYOK credential if no native auth header was set; preserve body/stream.
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Fetch errors can embed authenticated request details; never return or log them.
    return new Response("Provider gateway request failed.", { status: 502 });
  }
}

export function forwardGoogle(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx | string,
): Promise<Response> {
  const orgId = typeof ctx === "string" ? ctx : ctx?.orgId;
  return forwardProvider(request, env, "generativelanguage.googleapis.com", orgId);
}

export function forwardAnthropic(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx | string,
): Promise<Response> {
  const orgId = typeof ctx === "string" ? ctx : ctx?.orgId;
  return forwardProvider(request, env, "api.anthropic.com", orgId);
}

export function forwardOpenAI(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx | string,
): Promise<Response> {
  const orgId = typeof ctx === "string" ? ctx : ctx?.orgId;
  return forwardProvider(request, env, "api.openai.com", orgId);
}

export function forwardXAI(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx | string,
): Promise<Response> {
  const orgId = typeof ctx === "string" ? ctx : ctx?.orgId;
  return forwardProvider(request, env, "api.x.ai", orgId);
}

/**
 * OpenCode Go (spec §5.6): pinned to the canonical opencode.ai origin and
 * forwarded through the gateway's opencode-go custom provider, which holds
 * the issued API key as BYOK. The container's dummy key and any
 * container-supplied gateway controls are stripped by outboundHeaders; a
 * stable per-run session id rides through untouched.
 */
export function forwardOpenCodeGo(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx | string,
): Promise<Response> {
  const orgId = typeof ctx === "string" ? ctx : ctx?.orgId;
  return forwardProvider(request, env, "opencode.ai", orgId);
}

/** DeepSeek uses the same saved OpenCode key. There is no gateway slug. */
export function forwardDeepSeek(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx | string,
): Promise<Response> {
  const orgId = typeof ctx === "string" ? ctx : ctx?.orgId;
  return forwardProvider(request, env, "api.deepseek.com", orgId);
}

/**
 * T48 — the claude-subscription egress branch. The container holds only a
 * placeholder credentials.json; the real `claude setup-token` bearer is
 * attached here — `Authorization: Bearer <token>` plus the oauth beta
 * header the subscription surface requires. Deliberately NOT a
 * GATEWAY_PROVIDERS entry: subscription hosts ride this branch, never the
 * gateway's BYOK path. Deny-by-default: wrong host/protocol → 403, no
 * secret → 503 (fail closed, never silently forward).
 */
export async function forwardClaudeSubscription(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const secretName =
    account === "default"
      ? "CLAUDE_SUBSCRIPTION_TOKEN"
      : `CLAUDE_SUBSCRIPTION_TOKEN_${account.toUpperCase().replace(/-/g, "_")}`;
  const saved = await readProviderSecretForOrg(env, ctx?.orgId, "claude-setup");
  const configured = (env as Record<string, unknown>)[secretName];
  const token = saved ?? (typeof configured === "string" ? configured : undefined);
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "api.anthropic.com" ||
    target.port !== "" ||
    !["/v1/messages", "/v1/messages/count_tokens", "/v1/models"].includes(target.pathname) ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid subscription destination.", { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (typeof token !== "string" || token.trim() === "") {
    return new Response(`${secretName} is not configured on this deployment.`, { status: 503 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${token}`);
  // The subscription surface requires the oauth beta; container-supplied
  // copies are already stripped by outboundHeaders, so set it here.
  headers.set("anthropic-beta", "oauth-2025-04-20");
  headers.set("anthropic-version", "2023-06-01");
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Fetch errors can embed authenticated request details; never surface them.
    return new Response("Subscription request failed.", { status: 502 });
  }
}

/**
 * Legacy T47 verify forwarder for `/api/auth/codex-subscription` only.
 * Harness runs mount auth.json in the sandbox (chatgpt.com bot-challenges
 * Worker fetches — 2026-10-19). Deny-by-default path pin for verify probes.
 */
/**
 * ChatGPT plan inference for `codex-subscription`. The container's
 * ACCESS_TOKEN is a placeholder. This handler loads the per-user token from
 * ChatGptAuth and attaches it here — never in the sandbox, logs, or the UI.
 */
export async function forwardCodexPlan(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "api.openai.com" ||
    target.port !== "" ||
    !target.pathname.startsWith("/v1/") ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid subscription destination.", { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const userId = typeof params.userId === "string" ? params.userId.trim() : "";
  if (userId === "" || !env.ChatGptAuth) {
    return new Response("No ChatGPT plan is connected for this run.", { status: 503 });
  }
  const access = await chatGptAuthStub(env, userId).fetch("https://chatgpt-auth.internal/access");
  if (!access.ok) {
    return new Response("ChatGPT plan access is not available for this run.", { status: 503 });
  }
  const body = (await access.json().catch(() => null)) as {
    accessToken?: unknown;
    planUsageEnabled?: unknown;
  } | null;
  if (typeof body?.accessToken !== "string" || body.accessToken === "" || body.planUsageEnabled === false) {
    return new Response("ChatGPT plan access is not available for this run.", { status: 503 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${body.accessToken}`);
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    return new Response("Subscription request failed.", { status: 502 });
  }
}

export async function forwardCodexSubscription(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const userId = typeof params.userId === "string" && params.userId !== "" ? params.userId : undefined;
  const secretName =
    account === "default"
      ? "CODEX_SUBSCRIPTION_AUTH_JSON"
      : `CODEX_SUBSCRIPTION_AUTH_JSON_${account.toUpperCase().replace(/-/g, "_")}`;
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "chatgpt.com" ||
    target.port !== "" ||
    // Reject encoded paths rather than let upstream decoding escape the scope.
    !/^\/backend-api\/(codex|wham)\/[a-zA-Z0-9_./-]+$/.test(target.pathname) ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid subscription destination.", { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  const raw = await resolveCodexSubscriptionAuthJson(env as WorkerEnv, { account, userId });
  if (raw === null) {
    const hint = userId
      ? "No ChatGPT subscription is connected for this user."
      : `${secretName} is not configured on this deployment.`;
    return new Response(hint, { status: 503 });
  }
  const credential = parseResolvedCodexCredential(raw);
  if (credential === null) {
    return new Response("Stored codex auth.json is invalid — reconnect ChatGPT subscription in Settings.", { status: 503 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${credential.accessToken}`);
  if (credential.accountId !== null) {
    headers.set("chatgpt-account-id", credential.accountId);
  }
  headers.set("OpenAI-Beta", "responses=experimental");
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Fetch errors can embed authenticated request details; never surface them.
    return new Response("Subscription request failed.", { status: 502 });
  }
}

/**
 * The stored-secret parser moved to @shiba/shared (codex-home.ts) so
 * packages/auth can validate a provisioned auth.json without reaching
 * back into the app. Re-exported: callers keep `../egress.js` imports.
 */
export { parseCodexAuthJson } from "@shiba/shared";

/**
 * The cursor-subscription egress branch. The container holds only a dummy
 * CURSOR_API_KEY; the real Cursor Agent API key is attached here as
 * `Authorization: Bearer <token>` — the scheme Cursor's own API surface
 * documents (the Cloud Agents API accepts Basic or Bearer; the CLI's
 * Connect RPCs authenticate the same way). Deny-by-default on the two
 * hosts the CLI calls — api2.cursor.sh (API plane) and repo2.cursor.sh
 * (repo/context backend): wrong host/protocol → 403, no secret → 503
 * (fail closed, never silently forward).
 */
export async function forwardCursorSubscription(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const secretName =
    account === "default"
      ? "CURSOR_SUBSCRIPTION_TOKEN"
      : `CURSOR_SUBSCRIPTION_TOKEN_${account.toUpperCase().replace(/-/g, "_")}`;
  const token = (env as Record<string, unknown>)[secretName];
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    (target.hostname !== "api2.cursor.sh" && target.hostname !== "repo2.cursor.sh") ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid subscription destination.", { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (typeof token !== "string" || token.trim() === "") {
    return new Response(`${secretName} is not configured on this deployment.`, { status: 503 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${token}`);
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Fetch errors can embed authenticated request details; never surface them.
    return new Response("Subscription request failed.", { status: 502 });
  }
}

async function loadUserOAuthAccess(
  env: EgressEnv,
  userId: string,
  provider: "antigravity" | "cursor" | "xai",
): Promise<{ accessToken: string; projectId?: string } | null> {
  if (userId === "" || !env.UserProviderOAuth) return null;
  const response = await userProviderOAuthStub(env, userId).fetch(
    `https://user-provider-oauth.internal/access?provider=${provider}`,
  );
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    accessToken?: unknown;
    projectId?: unknown;
  } | null;
  if (typeof body?.accessToken !== "string" || body.accessToken === "") return null;
  return {
    accessToken: body.accessToken,
    ...(typeof body.projectId === "string" && body.projectId !== "" ? { projectId: body.projectId } : {}),
  };
}

/** Per-user Antigravity / Cloud Code Assist OAuth at egress. */
export async function forwardAntigravityUser(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const userId = typeof params.userId === "string" ? params.userId.trim() : "";
  const auth = await loadUserOAuthAccess(env, userId, "antigravity");
  const target = new URL(request.url);
  const allowed =
    target.hostname === "cloudcode-pa.googleapis.com" ||
    target.hostname === "daily-cloudcode-pa.googleapis.com" ||
    target.hostname === "dl.google.com" ||
    target.hostname === "generativelanguage.googleapis.com";
  if (target.protocol !== "https:" || !allowed || target.username !== "" || target.password !== "") {
    return new Response("Invalid Antigravity destination.", { status: 403 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  if (!auth) {
    // antigravity-subscription installs this handler whenever userId is set,
    // but the in-container agy profile lane authenticates with its own bearer
    // on Cloud Code hosts when the dashboard OAuth record is absent.
    const cloudCodeHost =
      target.hostname === "cloudcode-pa.googleapis.com" ||
      target.hostname === "daily-cloudcode-pa.googleapis.com";
    if (cloudCodeHost) {
      const profileAuth = request.headers.get("authorization");
      if (profileAuth) headers.set("Authorization", profileAuth);
    }
    try {
      return await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "POST" ? request.body : undefined,
        redirect: "manual",
      });
    } catch {
      return new Response("Subscription request failed.", { status: 502 });
    }
  }
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  if (auth.projectId) headers.set("x-goog-user-project", auth.projectId);
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    return new Response("Subscription request failed.", { status: 502 });
  }
}

/** Per-user Cursor OAuth at egress (api2 + repo2). */
export async function forwardCursorUser(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const userId = typeof params.userId === "string" ? params.userId.trim() : "";
  const auth = await loadUserOAuthAccess(env, userId, "cursor");
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    (target.hostname !== "api2.cursor.sh" && target.hostname !== "repo2.cursor.sh") ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid Cursor destination.", { status: 403 });
  }
  if (!auth) {
    const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
    return forwardCursorSubscription(request, env, { ...ctx, params: { account } });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    return new Response("Subscription request failed.", { status: 502 });
  }
}

/** Per-user xAI / Grok OAuth at egress. */
export async function forwardXaiUser(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const userId = typeof params.userId === "string" ? params.userId.trim() : "";
  const auth = await loadUserOAuthAccess(env, userId, "xai");
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.hostname !== "api.x.ai" || target.username !== "" || target.password !== "") {
    return new Response("Invalid xAI destination.", { status: 403 });
  }
  if (!auth) {
    return forwardXAI(request, env, ctx?.orgId);
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    return new Response("Subscription request failed.", { status: 502 });
  }
}

async function forwardGitHub(request: Request, env: EgressEnv): Promise<Response> {
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.hostname !== "github.com") {
    return new Response("Invalid repository destination.", { status: 403 });
  }
  target.username = "";
  target.password = "";
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  if (env.GITHUB_TOKEN) {
    headers.set("Authorization", `Basic ${btoa(`x-access-token:${env.GITHUB_TOKEN}`)}`);
  }
  const ce = headers.get("content-encoding") ?? "<none>";
  const gp = headers.get("git-protocol") ?? "<none>";
  // Buffer the request body so upstream sees a Content-Length, not chunked
  // transfer-encoding (smart-HTTP and Connect-RPC servers reject chunked
  // POSTs). Bodies on these paths are small: git-upload-pack wants, RPC calls.
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  if (body) headers.delete("content-length");
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    if (response.status >= 400) {
      console.warn(`github egress ${request.method} ${target.pathname} -> ${response.status} ce=${ce} gp=${gp}`);
    }
    return response;
  } catch {
    return new Response("Repository request failed.", { status: 502 });
  }
}

/**
 * True only for the approved repo itself, not a sibling that shares its prefix:
 * `/o/repo-evil` must not match `/o/repo`. GitHub paths are case-insensitive.
 */
export function isWithinRepoScope(pathname: string, allowedPath: string): boolean {
  const path = pathname.toLowerCase();
  const scope = allowedPath.toLowerCase();
  if (!scope.startsWith("/") || scope === "/") return false;
  if (path === scope || path === `${scope}.git`) return true;
  return path.startsWith(`${scope}/`) || path.startsWith(`${scope}.git/`);
}

/**
 * The container only ever fetches. Pushing is a Worker-side REST concern, so
 * a run that tries to push with the injected credential is refused here rather
 * than trusted to behave.
 */
export function isAllowedGitHubRequest(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return true;
  if (verb !== "POST") return false;
  return pathname.toLowerCase().endsWith("/git-upload-pack");
}

/**
 * B6: the credential is scoped to the one repo this run was approved for, so
 * repository code cannot reach every other repo the token can.
 */
export async function forwardGitHubScoped(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const allowedPath = approvedPath(ctx);
  if (!allowedPath) {
    return new Response("Repository scope was never approved for this run.", { status: 403 });
  }
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.hostname !== "github.com") {
    return new Response("Invalid repository destination.", { status: 403 });
  }
  if (!isWithinRepoScope(target.pathname, allowedPath)) {
    return new Response("Repository outside the approved scope.", { status: 403 });
  }
  if (!isAllowedGitHubRequest(request.method, target.pathname)) {
    return new Response("Only read-only repository traffic is allowed for this run.", { status: 403 });
  }
  return forwardGitHub(request, env);
}

/** No run has claimed a repo yet, so no credential may leave. */
export function denyUnscopedGitHub(): Promise<Response> {
  return Promise.resolve(
    new Response("Repository scope was never approved for this run.", { status: 403 }),
  );
}
