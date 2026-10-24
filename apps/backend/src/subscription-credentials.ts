/**
 * Per-user ChatGPT (Codex) subscription credentials — encrypted auth.json at
 * rest on AGENT_AUDIT D1. Nothing in this module returns secret fields over HTTP.
 */
import type { Env } from "./env.js";
import { parseCodexAuthJson } from "@shiba/shared";

export const OPENAI_SUBSCRIPTION_KIND = "openai-subscription";
export const DEFAULT_WORKSPACE_ID = "default";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS user_subscription_credentials (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    auth_cipher TEXT NOT NULL,
    account_email_hash TEXT,
    expires_at INTEGER,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, kind)
  )`,
];
const initialized = new WeakSet<D1Database>();

export interface SubscriptionCredentialStatus {
  connected: boolean;
  accountEmailHash?: string;
  expiresAt?: number;
  savedAt?: number;
}

export class SubscriptionCredentialError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SubscriptionCredentialError";
  }
}

function base64url(bytes: Uint8Array): string {
  // Chunked: spreading a large buffer into fromCharCode overflows the call stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

export function modelCredentialKeyConfigured(env?: Pick<Env, "MODEL_CREDENTIAL_KEY">): boolean {
  return /^[a-fA-F0-9]{64}$/.test(env?.MODEL_CREDENTIAL_KEY ?? "");
}

function requireKey(env: Pick<Env, "MODEL_CREDENTIAL_KEY">): string {
  if (!modelCredentialKeyConfigured(env)) {
    throw new SubscriptionCredentialError("Per-user subscription storage is not configured (MODEL_CREDENTIAL_KEY).", 503);
  }
  return env.MODEL_CREDENTIAL_KEY!;
}

async function importAesKey(hex: string): Promise<CryptoKey> {
  const key = Uint8Array.from(hex.match(/../g)!, (part) => Number.parseInt(part, 16));
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function aad(workspaceId: string, userId: string, kind: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["subscription-credential-v1", workspaceId, userId, kind]));
}

export async function encryptAuthJson(
  plaintext: string,
  keyHex: string,
  workspaceId: string,
  userId: string,
  kind: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(workspaceId, userId, kind), tagLength: 128 },
    await importAesKey(keyHex),
    new TextEncoder().encode(plaintext),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(cipher))}`;
}

export async function decryptAuthJson(
  cipher: string,
  keyHex: string,
  workspaceId: string,
  userId: string,
  kind: string,
): Promise<string> {
  const [version, encodedIv, encodedCipher, extra] = cipher.split(".");
  if (version !== "v1" || !encodedIv || !encodedCipher || extra !== undefined) {
    throw new SubscriptionCredentialError("Stored credential is corrupt.", 500);
  }
  const iv = fromBase64url(encodedIv);
  if (iv.length !== 12) throw new SubscriptionCredentialError("Stored credential is corrupt.", 500);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad(workspaceId, userId, kind), tagLength: 128 },
    await importAesKey(keyHex),
    fromBase64url(encodedCipher),
  );
  return new TextDecoder().decode(plaintext);
}

export async function ensureSubscriptionCredentialSchema(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  if (!env.AGENT_AUDIT) throw new SubscriptionCredentialError("Subscription storage unavailable.", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  await env.AGENT_AUDIT.batch(SCHEMA.map((sql) => env.AGENT_AUDIT.prepare(sql)));
  initialized.add(env.AGENT_AUDIT);
}

function jwtExp(accessToken: string): number | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function emailHashFromAuthJson(raw: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(raw) as { tokens?: { id_token?: unknown } };
    const idToken = parsed.tokens?.id_token;
    if (typeof idToken !== "string" || idToken === "") return null;
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { email?: unknown };
    if (typeof payload.email !== "string" || payload.email === "") return null;
    return await sha256Hex(payload.email.trim().toLowerCase());
  } catch {
    return null;
  }
}

export function validateAuthJsonPayload(raw: string): void {
  if (parseCodexAuthJson(raw) === null) {
    throw new SubscriptionCredentialError("auth.json is not a valid Codex ChatGPT credential file.");
  }
  if (raw.includes("access_token") === false) {
    throw new SubscriptionCredentialError("auth.json is missing token fields.");
  }
}

export async function saveUserSubscriptionAuthJson(
  env: Env,
  userId: string,
  authJson: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<SubscriptionCredentialStatus> {
  await ensureSubscriptionCredentialSchema(env);
  validateAuthJsonPayload(authJson);
  const key = requireKey(env);
  const cipher = await encryptAuthJson(authJson, key, workspaceId, userId, OPENAI_SUBSCRIPTION_KIND);
  const parsed = parseCodexAuthJson(authJson)!;
  const expiresAt = jwtExp(parsed.accessToken);
  const accountEmailHash = await emailHashFromAuthJson(authJson);
  const savedAt = Date.now();
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO user_subscription_credentials
      (workspace_id, user_id, kind, auth_cipher, account_email_hash, expires_at, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id, kind) DO UPDATE SET
      auth_cipher = excluded.auth_cipher,
      account_email_hash = excluded.account_email_hash,
      expires_at = excluded.expires_at,
      saved_at = excluded.saved_at`,
  )
    .bind(workspaceId, userId, OPENAI_SUBSCRIPTION_KIND, cipher, accountEmailHash, expiresAt ?? null, savedAt)
    .run();
  return {
    connected: true,
    ...(accountEmailHash ? { accountEmailHash } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    savedAt,
  };
}

export async function readUserSubscriptionStatus(
  env: Env,
  userId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<SubscriptionCredentialStatus> {
  await ensureSubscriptionCredentialSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT account_email_hash, expires_at, saved_at FROM user_subscription_credentials
     WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(workspaceId, userId, OPENAI_SUBSCRIPTION_KIND)
    .first<{ account_email_hash: string | null; expires_at: number | null; saved_at: number }>();
  if (!row) return { connected: false };
  return {
    connected: true,
    ...(row.account_email_hash ? { accountEmailHash: row.account_email_hash } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    savedAt: row.saved_at,
  };
}

export async function deleteUserSubscriptionCredential(
  env: Env,
  userId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  await ensureSubscriptionCredentialSchema(env);
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM user_subscription_credentials WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(workspaceId, userId, OPENAI_SUBSCRIPTION_KIND)
    .run();
}

/** Worker-only: load decrypted auth.json for egress / refresh. */
export async function loadUserSubscriptionAuthJson(
  env: Env,
  userId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<string | null> {
  if (!modelCredentialKeyConfigured(env)) return null;
  await ensureSubscriptionCredentialSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT auth_cipher FROM user_subscription_credentials
     WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(workspaceId, userId, OPENAI_SUBSCRIPTION_KIND)
    .first<{ auth_cipher: string }>();
  if (!row) return null;
  return decryptAuthJson(row.auth_cipher, env.MODEL_CREDENTIAL_KEY!, workspaceId, userId, OPENAI_SUBSCRIPTION_KIND);
}

export async function persistUserSubscriptionAuthJson(
  env: Env,
  userId: string,
  authJson: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  await saveUserSubscriptionAuthJson(env, userId, authJson, workspaceId);
}

function accessTokenExpMs(authJson: string): number {
  try {
    const parsed = parseCodexAuthJson(authJson);
    if (!parsed) return 0;
    return jwtExp(parsed.accessToken) ?? 0;
  } catch {
    return 0;
  }
}

/** After a run, keep the readback only when its access token expires later (concurrent runs). */
export async function mergePersistUserSubscriptionAuthJson(
  env: Env,
  userId: string,
  readback: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  validateAuthJsonPayload(readback);
  const existing = await loadUserSubscriptionAuthJson(env, userId, workspaceId);
  if (existing === null || accessTokenExpMs(readback) >= accessTokenExpMs(existing)) {
    await saveUserSubscriptionAuthJson(env, userId, readback, workspaceId);
  }
}
