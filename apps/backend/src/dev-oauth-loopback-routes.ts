/**
 * Local dev only: OAuth loopback servers POST callback URLs (authenticated with a
 * per-dev-run secret); the dashboard polls by pending OAuth state while sign-in
 * is waiting.
 */
import type { AcpProviderId } from "@shiba/shared";
import { waitingProviderOauthState } from "./acp-providers.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { timingSafeEqualString } from "./security.js";

export const DEV_OAUTH_LOOPBACK_HEADER = "x-shiba-dev-oauth-loopback-secret";

const CALLBACK_TTL_MS = 5 * 60 * 1000;

type StoredCallback = { url: string; at: number };

/** @internal in-memory; dev Worker isolate only */
const byState = new Map<string, StoredCallback>();

function devLoopbackHost(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

function devLoopbackSecretConfigured(env: Env): boolean {
  const secret = env.SHIBA_DEV_OAUTH_LOOPBACK_SECRET?.trim() ?? "";
  return secret.length >= 16;
}

function loopbackSecretMatches(request: Request, env: Env): boolean {
  const expected = env.SHIBA_DEV_OAUTH_LOOPBACK_SECRET?.trim() ?? "";
  if (expected.length < 16) return false;
  const presented = request.headers.get(DEV_OAUTH_LOOPBACK_HEADER)?.trim() ?? "";
  if (presented === "") return false;
  return timingSafeEqualString(presented, expected);
}

function isLoopbackCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return false;
    if (parsed.pathname !== "/callback" && parsed.pathname !== "/auth/callback") return false;
    const port = parsed.port;
    return port === "51121" || port === "56121" || port === "" || parsed.pathname === "/auth/callback";
  } catch {
    return false;
  }
}

export function oauthStateFromCallbackUrl(url: string): string | null {
  try {
    const state = new URL(url).searchParams.get("state")?.trim() ?? "";
    return state === "" ? null : state;
  } catch {
    return null;
  }
}

function pruneExpired(): void {
  const cutoff = Date.now() - CALLBACK_TTL_MS;
  for (const [state, row] of byState) {
    if (row.at < cutoff) byState.delete(state);
  }
}

function storeCallback(state: string, url: string): void {
  pruneExpired();
  byState.set(state, { url, at: Date.now() });
}

function takeCallback(state: string): string | null {
  pruneExpired();
  const row = byState.get(state);
  if (!row) return null;
  byState.delete(state);
  if (Date.now() - row.at > CALLBACK_TTL_MS) return null;
  return row.url;
}

const LOOPBACK_PROVIDER_IDS = new Set<AcpProviderId>(["gemini", "grok"]);

function parseProviderId(raw: string | null): AcpProviderId | null {
  if (raw === "gemini" || raw === "grok") return raw;
  return null;
}

export function resetDevOAuthLoopbackForTests(): void {
  byState.clear();
}

export async function handleDevOAuthLoopback(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/api/dev/oauth-loopback") return null;
  if (!devLoopbackHost(request)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (!devLoopbackSecretConfigured(env)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  if (request.method === "POST") {
    if (!loopbackSecretMatches(request, env)) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
    const body = (await request.json().catch(() => null)) as { url?: string } | null;
    const url = body?.url?.trim() ?? "";
    if (!isLoopbackCallbackUrl(url)) {
      return Response.json({ error: "Invalid callback URL." }, { status: 400 });
    }
    const state = oauthStateFromCallbackUrl(url);
    if (state === null) {
      return Response.json({ error: "Callback URL is missing OAuth state." }, { status: 400 });
    }
    storeCallback(state, url);
    return Response.json({ ok: true });
  }

  if (request.method === "GET") {
    if (!(await isAuthorizedRequest(request, env))) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    const url = new URL(request.url);
    const state = url.searchParams.get("state")?.trim() ?? "";
    const providerId = parseProviderId(url.searchParams.get("provider"));
    if (state === "" || providerId === null || !LOOPBACK_PROVIDER_IDS.has(providerId)) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    const org = (await resolveUserId(request, env)) ?? "default";
    const pending = await waitingProviderOauthState(env, org, providerId);
    if (pending === null || pending !== state) {
      return Response.json({ error: "No matching sign-in." }, { status: 404 });
    }
    const callbackUrl = takeCallback(state);
    if (callbackUrl === null) {
      return Response.json({ callbackUrl: null });
    }
    return Response.json({ callbackUrl });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
