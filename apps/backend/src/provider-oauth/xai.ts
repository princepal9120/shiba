/**
 * xAI / Grok OAuth — ported from opencodex src/oauth/xai.ts (OIDC discovery + PKCE).
 */
import { generatePkce, randomBase64Url } from "./pkce.js";
import type { UserOAuthRecord } from "./types.js";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_REDIRECT_URI = "http://127.0.0.1:56121/callback";
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const TRUSTED_HOSTS = new Set(["auth.x.ai", "accounts.x.ai"]);

export interface XaiBeginResult {
  authorizeUrl: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  tokenEndpoint: string;
  nonce: string;
}

function validateEndpoint(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error("xAI OAuth discovery returned an unexpected endpoint.");
  }
  return parsed.toString();
}

export async function discoverXaiEndpoints(): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`xAI OAuth discovery failed: ${response.status}`);
  const payload = (await response.json()) as {
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
  };
  if (typeof payload.authorization_endpoint !== "string" || typeof payload.token_endpoint !== "string") {
    throw new Error("xAI OAuth discovery response missing endpoints.");
  }
  return {
    authorizationEndpoint: validateEndpoint(payload.authorization_endpoint),
    tokenEndpoint: validateEndpoint(payload.token_endpoint),
  };
}

export async function beginXaiOAuth(): Promise<XaiBeginResult> {
  const discovery = await discoverXaiEndpoints();
  const state = randomBase64Url(24);
  const nonce = crypto.randomUUID();
  const { verifier, challenge } = await generatePkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: XAI_REDIRECT_URI,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return {
    authorizeUrl: `${discovery.authorizationEndpoint}?${params.toString()}`,
    redirectUri: XAI_REDIRECT_URI,
    state,
    codeVerifier: verifier,
    tokenEndpoint: discovery.tokenEndpoint,
    nonce,
  };
}

interface XaiTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
  try {
    return JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jwtIdentity(
  accessToken: string,
  idToken?: string,
  expectedNonce?: string,
): { email?: string; accountId?: string } {
  if (idToken && expectedNonce) {
    const payload = decodeJwtPayload(idToken);
    const nonce = payload?.nonce;
    if (typeof nonce !== "string" || nonce !== expectedNonce) {
      throw new Error("xAI id_token nonce did not match the sign-in request.");
    }
  }
  const payload = decodeJwtPayload(idToken ?? accessToken);
  if (!payload) return {};
  return {
    ...(typeof payload.email === "string" && payload.email ? { email: payload.email.toLowerCase() } : {}),
    ...(typeof payload.sub === "string" && payload.sub ? { accountId: payload.sub } : {}),
  };
}

async function postToken(tokenEndpoint: string, body: Record<string, string>): Promise<XaiTokenPayload> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) throw new Error(`xAI token request failed: ${response.status}`);
  return (await response.json()) as XaiTokenPayload;
}

function recordFromPayload(payload: XaiTokenPayload, refreshFallback = "", expectedNonce?: string): UserOAuthRecord {
  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    throw new Error("xAI token response did not include an access token.");
  }
  const refresh =
    typeof payload.refresh_token === "string" && payload.refresh_token !== ""
      ? payload.refresh_token
      : refreshFallback;
  if (!refresh) throw new Error("xAI token response did not include a refresh token.");
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  const identity = jwtIdentity(payload.access_token, idToken, expectedNonce);
  return {
    accessToken: payload.access_token,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    ...identity,
    savedAt: Date.now(),
  };
}

export async function exchangeXaiCode(
  code: string,
  codeVerifier: string,
  tokenEndpoint: string,
  expectedNonce?: string,
): Promise<UserOAuthRecord> {
  const payload = await postToken(tokenEndpoint, {
    grant_type: "authorization_code",
    client_id: XAI_OAUTH_CLIENT_ID,
    code,
    redirect_uri: XAI_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  return recordFromPayload(payload, "", expectedNonce);
}

export async function refreshXaiToken(refreshToken: string, tokenEndpoint: string): Promise<UserOAuthRecord> {
  const payload = await postToken(tokenEndpoint, {
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  return recordFromPayload(payload, refreshToken);
}

export function parseXaiCallbackCode(callbackUrl: string, expectedState: string): string {
  const url = new URL(callbackUrl);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") {
    throw new Error("Paste the complete http://127.0.0.1 redirect URL from xAI sign-in.");
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== expectedState) {
    throw new Error("That callback does not match the current sign-in.");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    const err = url.searchParams.get("error");
    throw new Error(err ? `xAI sign-in failed: ${err}` : "The callback URL is missing an authorization code.");
  }
  return code;
}
