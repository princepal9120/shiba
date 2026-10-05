/**
 * T52 `/api/computers` — the dashboard's view of the paired daemon fleet.
 * Dashboard-auth only (Access identity, same gate as /api/approvals); the
 * daemon bearer never reaches here and no chat surface routes to it.
 *   GET  /api/computers               → {computers: ConnectedComputer[]}
 *   POST /api/computers/revoke        {machineId} → {ok:true}
 *   POST /api/computers/pairing-token → {token, expiresAt, connectCommand}
 * Dark (404) unless SHIBA_LOCAL_RUNTIME=1 and the LocalDispatch DO is bound.
 */
import { LOCAL_ADAPTER_TOKEN_ENV, LOCAL_PAIRING_TTL_MS, LOCAL_RUNTIME_FLAG, type PairingTokenResponse } from "@shiba/shared";
import type { Env } from "./env.js";
import { localDispatchStub } from "./local-dispatch.js";
import { randomHex } from "./mailbox-store.js";
import { isAuthenticated } from "./request-auth.js";
import { methodNotAllowed } from "./route-utils.js";

/** PAIRING_SECRET, else the deployment's daemon bearer — single-tenant acceptable. */
export function pairingSecret(env: Env): string | undefined {
  return env.PAIRING_SECRET?.trim() || env[LOCAL_ADAPTER_TOKEN_ENV]?.trim() || undefined;
}

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/** `base64url({n, exp}).base64url(hmac_sha256(payload, secret))` — the nonce is what the DO burns on use. */
export async function signPairingToken(secret: string, nonce: string, expiresAt: number): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ n: nonce, exp: expiresAt })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The nonce of a validly signed, unexpired token, else null. subtle.verify is constant-time. */
export async function verifyPairingToken(secret: string, token: string, now: number): Promise<{ nonce: string; expiresAt: number } | null> {
  const [payload, signature, extra] = token.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) return null;
  const sigBytes = fromBase64Url(signature);
  const payloadBytes = fromBase64Url(payload);
  if (sigBytes === null || payloadBytes === null) return null;
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sigBytes, new TextEncoder().encode(payload));
  if (!valid) return null;
  try {
    const { n, exp } = JSON.parse(new TextDecoder().decode(payloadBytes)) as { n?: unknown; exp?: unknown };
    if (typeof n !== "string" || typeof exp !== "number" || now > exp) return null;
    return { nonce: n, expiresAt: exp };
  } catch {
    return null;
  }
}

export async function handleComputers(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/computers" && !url.pathname.startsWith("/api/computers/")) {
    return null;
  }
  if (!isAuthenticated(request, env)) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const stub = localDispatchStub(env);

  if (url.pathname === "/api/computers") {
    if (request.method !== "GET") return methodNotAllowed();
    return stub.fetch(new Request("https://local-dispatch/computers"));
  }

  if (url.pathname === "/api/computers/revoke") {
    if (request.method !== "POST") return methodNotAllowed();
    const body = (await request.json().catch(() => null)) as { machineId?: unknown } | null;
    if (typeof body?.machineId !== "string" || body.machineId === "") {
      return Response.json({ error: "machineId is required." }, { status: 400 });
    }
    return stub.fetch(new Request("https://local-dispatch/revoke-computer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: body.machineId }),
    }));
  }

  if (url.pathname === "/api/computers/pairing-token") {
    if (request.method !== "POST") return methodNotAllowed();
    const secret = pairingSecret(env);
    if (secret === undefined) {
      return Response.json({ error: "Pairing is not configured: set PAIRING_SECRET or LOCAL_ADAPTER_TOKEN." }, { status: 503 });
    }
    const nonce = randomHex(16);
    const expiresAt = Date.now() + LOCAL_PAIRING_TTL_MS;
    const stored = await stub.fetch(new Request("https://local-dispatch/pairing-nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce, expiresAt }),
    }));
    if (!stored.ok) return Response.json({ error: "Could not mint a pairing token." }, { status: 500 });
    const token = await signPairingToken(secret, nonce, expiresAt);
    const response: PairingTokenResponse = {
      token,
      expiresAt,
      connectCommand: `node scripts/shiba-local-daemon.mjs --connect ${url.origin} --pair ${token}`,
    };
    return Response.json(response);
  }

  return Response.json({ error: "Not found." }, { status: 404 });
}
