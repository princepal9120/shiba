/**
 * Per-surface request auth: Cloudflare Access identity, the exact
 * signature-authenticated callback paths, and the bearer-surface
 * exemptions (/mcp, automation webhooks). Extracted from index.ts — the
 * split keeps each surface's own gate, per PLAN.md §18.0.
 */
import { parseAutomationWebhookPath } from "./automations.js";
import {
  isBetterAuthConfigured,
  isBetterAuthPath,
  resolveBetterAuthUserId,
} from "./better-auth.js";
import type { Env } from "./env.js";
import { isLocalRuntimePath } from "./local-routes.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackRequest(request: Request): boolean {
  const { hostname } = new URL(request.url);
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

export function isAccessConfigured(env: Env): boolean {
  return Boolean(env.REQUIRE_ACCESS || env.ACCESS_AUD);
}

export function getUserId(request: Request): string | null {
  const email = request.headers.get("CF-Access-Authenticated-User-Email");
  if (!email || email.trim() === "") {
    return null;
  }
  return email.trim();
}

// Only these exact callbacks use signatures instead of an Access identity.
export const SIGNATURE_AUTHENTICATED = [
  "/api/slack/events",
  "/api/slack/command",
  "/api/slack/interact",
  "/api/telegram/webhook",
  "/api/discord/interactions",
  "/api/github/webhook",
  "/api/trigger",
];

export function isAutomationWebhookPath(pathname: string): boolean {
  return parseAutomationWebhookPath(pathname) !== null;
}

export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

// OAuth discovery/metadata/registration/token endpoints are anonymous by
// protocol — a client cannot hold an Access identity before these run.
export function isOAuthPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/revoke"
  );
}

export function isAuthenticated(request: Request, env: Env): boolean {
  const { pathname } = new URL(request.url);
  if (SIGNATURE_AUTHENTICATED.includes(pathname)) return true;
  if (isAutomationWebhookPath(pathname)) return true;
  // `/mcp` runs on bearer tokens, not Access identity — the handler itself
  // verifies before any MCP traffic is served.
  if (isMcpPath(pathname)) return true;
  if (isOAuthPath(pathname)) return true;
  // `/api/local` self-authenticates with a bearer token — same shape as
  // /mcp, exempt from the Access gate.
  if (isLocalRuntimePath(pathname)) return true;
  // `/api/auth/*` self-authenticates: sign-in/sign-up/session verbs are how
  // a caller proves identity in the first place. The subscription-connect
  // paths under /api/auth are NOT exempted here — they stay gated below.
  if (isBetterAuthPath(pathname) && isBetterAuthConfigured(env)) return true;
  // With no identity system configured, only local development hosts bypass.
  if (!isAccessConfigured(env) && !isBetterAuthConfigured(env)) {
    return isLoopbackRequest(request);
  }
  // Access deployments trust the (edge/JWT-verified) identity header.
  if (isAccessConfigured(env)) return getUserId(request) !== null;
  // better-auth mode needs the async session check — see isAuthorizedRequest.
  return false;
}

/**
 * Full async gate: the synchronous {@link isAuthenticated} check plus the
 * better-auth cookie-session verification when the lane is configured.
 * index.ts's gate and every route module's own recheck should await this;
 * `isAuthenticated` alone only answers "identity proven so far".
 */
export async function isAuthorizedRequest(
  request: Request,
  env: Env,
): Promise<boolean> {
  return (
    isAuthenticated(request, env) ||
    (await resolveBetterAuthUserId(request, env)) !== null
  );
}

/**
 * Async identity resolution for the dashboard surfaces: the verified
 * Access email when Access is configured, the better-auth session email
 * for the built-in lane, else the raw header (loopback dev) or null.
 */
export async function resolveUserId(
  request: Request,
  env: Env,
): Promise<string | null> {
  if (isAccessConfigured(env)) {
    return getUserId(request) ?? (await resolveBetterAuthUserId(request, env));
  }
  if (isBetterAuthConfigured(env)) {
    return resolveBetterAuthUserId(request, env);
  }
  return getUserId(request);
}
