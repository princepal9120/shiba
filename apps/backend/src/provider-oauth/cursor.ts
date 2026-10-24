/**
 * Cursor account OAuth (PKCE poll) — ported from opencodex src/oauth/cursor.ts.
 */
import { generatePkce } from "./pkce.js";
import type { UserOAuthRecord } from "./types.js";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF = 1.2;
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 60 * 60 * 1000;
const POLL_TERMINAL_STATUSES = new Set([400, 401, 403, 410]);

export interface CursorBeginResult {
  loginUrl: string;
  uuid: string;
  verifier: string;
}

export async function beginCursorOAuth(): Promise<CursorBeginResult> {
  const { verifier, challenge } = await generatePkce();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
  return { loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}`, uuid, verifier };
}

function decodeJwt(token: string): { exp?: number; email?: string; sub?: string } | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
      email?: string;
      sub?: string;
    };
  } catch {
    return undefined;
  }
}

function recordFromTokens(accessToken: string, refreshToken: string): UserOAuthRecord {
  const payload = decodeJwt(accessToken) ?? decodeJwt(refreshToken);
  const expMs =
    typeof payload?.exp === "number" ? payload.exp * 1000 - EXPIRY_SKEW_MS : Date.now() + FALLBACK_TTL_MS;
  return {
    accessToken,
    refreshToken,
    expiresAt: expMs,
    ...(typeof payload?.email === "string" ? { email: payload.email.toLowerCase() } : {}),
    ...(payload?.sub !== undefined ? { accountId: String(payload.sub) } : {}),
    savedAt: Date.now(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One poll attempt — the dashboard calls Finish sign-in repeatedly until connected. */
export async function pollCursorOnce(
  uuid: string,
  verifier: string,
): Promise<{ status: "pending" } | { status: "connected"; record: UserOAuthRecord }> {
  const url = `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
  const response = await fetch(url);
  if (response.status === 404) {
    return { status: "pending" };
  }
  if (response.ok) {
    const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
    if (!data.accessToken || !data.refreshToken) {
      throw new Error("Cursor auth response missing tokens.");
    }
    return { status: "connected", record: recordFromTokens(data.accessToken, data.refreshToken) };
  }
  if (POLL_TERMINAL_STATUSES.has(response.status)) {
    throw new Error(`Cursor login rejected (HTTP ${response.status}). Start sign-in again.`);
  }
  throw new Error(`Cursor auth poll failed: ${response.status}`);
}

export async function pollCursorOAuth(
  uuid: string,
  verifier: string,
  opts?: { baseDelayMs?: number; maxAttempts?: number },
): Promise<UserOAuthRecord> {
  let delay = opts?.baseDelayMs ?? POLL_BASE_DELAY_MS;
  const maxAttempts = opts?.maxAttempts ?? POLL_MAX_ATTEMPTS;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(delay);
    try {
      const url = `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
      const response = await fetch(url);
      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
        continue;
      }
      if (response.ok) {
        const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
        if (!data.accessToken || !data.refreshToken) {
          throw new Error("Cursor auth response missing tokens.");
        }
        return recordFromTokens(data.accessToken, data.refreshToken);
      }
      if (POLL_TERMINAL_STATUSES.has(response.status)) {
        throw new Error(`Cursor login rejected (HTTP ${response.status}). Start sign-in again.`);
      }
      throw new Error(`Cursor auth poll failed: ${response.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("rejected")) throw err;
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new Error("Too many errors while waiting for Cursor sign-in.");
      }
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
    }
  }
  throw new Error("Cursor sign-in timed out. Open the login page again and approve, then Finish sign-in.");
}

export async function refreshCursorToken(refreshToken: string): Promise<UserOAuthRecord> {
  const response = await fetch(CURSOR_REFRESH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${refreshToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`Cursor token refresh failed: ${response.status}`);
  }
  const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
  if (!data.accessToken) throw new Error("Cursor refresh response missing access token.");
  return recordFromTokens(data.accessToken, data.refreshToken || refreshToken);
}
