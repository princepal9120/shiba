/**
 * Google Antigravity (Cloud Code Assist) OAuth — ported from opencodex
 * src/oauth/google-antigravity.ts (PKCE + offline refresh + project discovery).
 */
import { generatePkce, randomBase64Url } from "./pkce.js";
import type { UserOAuthRecord } from "./types.js";
import type { AntigravityOAuthClient } from "./antigravity-client.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROD_API = "https://cloudcode-pa.googleapis.com";
const DAILY_API = "https://daily-cloudcode-pa.googleapis.com";
const API_VERSION = "v1internal";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
export const ANTIGRAVITY_LOOPBACK_PORT = 51121;
export const ANTIGRAVITY_REDIRECT_URI = `http://127.0.0.1:${ANTIGRAVITY_LOOPBACK_PORT}/callback`;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface AntigravityBeginResult {
  authorizeUrl: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}

export async function beginAntigravityOAuth(client: AntigravityOAuthClient): Promise<AntigravityBeginResult> {
  const state = randomBase64Url(24);
  const { verifier, challenge } = await generatePkce();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return {
    authorizeUrl: `${AUTH_ENDPOINT}?${params.toString()}`,
    redirectUri: ANTIGRAVITY_REDIRECT_URI,
    state,
    codeVerifier: verifier,
  };
}

interface GoogleTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
}

async function postToken(client: AntigravityOAuthClient, body: Record<string, string>): Promise<GoogleTokenPayload> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Antigravity token request failed: ${response.status}`);
  }
  return (await response.json()) as GoogleTokenPayload;
}

function decodeJwtEmail(accessToken: string, idToken?: string): string | undefined {
  const part = (idToken ?? accessToken).split(".")[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { email?: unknown };
    return typeof payload.email === "string" && payload.email.length > 0 ? payload.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function extractProjectId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
      return (value as { id: string }).id;
    }
  }
  return undefined;
}

async function loadCodeAssistProject(accessToken: string): Promise<string | undefined> {
  const response = await fetch(`${PROD_API}/${API_VERSION}:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "*/*",
      "Content-Type": "application/json",
      "User-Agent": "antigravity/ide/2.5.5 (shiba; oauth)",
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  });
  if (!response.ok) return undefined;
  const data = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  return extractProjectId(data);
}

async function onboardProject(accessToken: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${DAILY_API}/${API_VERSION}:onboardUser`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
        "Content-Type": "application/json",
        "User-Agent": "antigravity/ide/2.5.5 (shiba; oauth)",
      },
      body: JSON.stringify({
        tier_id: "free-tier",
        metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: "2.5.5" },
      }),
    });
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      return undefined;
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.done === true) {
      return extractProjectId(data.response as Record<string, unknown> | undefined);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return undefined;
}

async function discoverProjectId(accessToken: string): Promise<string | undefined> {
  const loaded = await loadCodeAssistProject(accessToken);
  if (loaded) return loaded;
  return onboardProject(accessToken);
}

function recordFromPayload(payload: GoogleTokenPayload, refreshFallback = ""): UserOAuthRecord {
  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    throw new Error("Antigravity token response did not include an access token.");
  }
  const refresh =
    typeof payload.refresh_token === "string" && payload.refresh_token !== ""
      ? payload.refresh_token
      : refreshFallback;
  if (!refresh) throw new Error("Antigravity token response did not include a refresh token.");
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  return {
    accessToken: payload.access_token,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    email: decodeJwtEmail(payload.access_token, idToken),
    savedAt: Date.now(),
  };
}

export async function exchangeAntigravityCode(
  client: AntigravityOAuthClient,
  code: string,
  codeVerifier: string,
): Promise<UserOAuthRecord> {
  const payload = await postToken(client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  const record = recordFromPayload(payload);
  const projectId = await discoverProjectId(record.accessToken);
  if (!projectId) {
    throw new Error(
      "Antigravity login could not discover a Cloud Code Assist project. Ensure the Google account has Antigravity access.",
    );
  }
  return { ...record, projectId };
}

export async function refreshAntigravityToken(
  client: AntigravityOAuthClient,
  refreshToken: string,
): Promise<UserOAuthRecord> {
  const payload = await postToken(client, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const record = recordFromPayload(payload, refreshToken);
  const projectId = await discoverProjectId(record.accessToken);
  return projectId ? { ...record, projectId } : record;
}

export function parseAntigravityCallbackCode(callbackUrl: string, expectedState: string): string {
  const url = new URL(callbackUrl);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") {
    throw new Error("Paste the complete http://127.0.0.1 redirect URL from Google sign-in.");
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== expectedState) {
    throw new Error("That callback does not match the current sign-in.");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    const err = url.searchParams.get("error");
    throw new Error(err ? `Google sign-in failed: ${err}` : "The callback URL is missing an authorization code.");
  }
  return code;
}
