/**
 * Per-surface request auth: Cloudflare Access identity, the exact
 * signature-authenticated callback paths, and the bearer-surface
 * exemptions (/mcp, automation webhooks). Extracted from index.ts — the
 * split keeps each surface's own gate, per PLAN.md §18.0.
 */
import { parseAutomationWebhookPath } from "./automations.js";
import type { Env } from "./env.js";


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

export function isAuthenticated(request: Request, env: Env): boolean {
  const { pathname } = new URL(request.url);
  if (SIGNATURE_AUTHENTICATED.includes(pathname)) return true;
  if (isAutomationWebhookPath(pathname)) return true;
  // `/mcp` runs on bearer tokens, not Access identity — the handler itself
  // verifies before any MCP traffic is served.
  if (isMcpPath(pathname)) return true;
  if (!env.REQUIRE_ACCESS && !env.ACCESS_AUD) return true; // opt-out for `wrangler dev`
  return getUserId(request) !== null;
}
