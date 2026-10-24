/**
 * Encrypted per-user OAuth tokens for Providers sign-in (Antigravity, Cursor, xAI).
 */
import type { Env } from "./env.js";
import type { UserOAuthProvider, UserOAuthRecord } from "./provider-oauth/types.js";
import {
  decryptAuthJson,
  encryptAuthJson,
  ensureSubscriptionCredentialSchema,
  modelCredentialKeyConfigured,
  DEFAULT_WORKSPACE_ID,
} from "./subscription-credentials.js";

const KIND: Record<UserOAuthProvider, string> = {
  antigravity: "google-antigravity-oauth",
  cursor: "cursor-oauth",
  xai: "xai-oauth",
};

export function oauthKind(provider: UserOAuthProvider): string {
  return KIND[provider];
}

export async function loadUserOAuthRecord(
  env: Env,
  userId: string,
  provider: UserOAuthProvider,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<UserOAuthRecord | null> {
  if (!modelCredentialKeyConfigured(env)) return null;
  await ensureSubscriptionCredentialSchema(env);
  const kind = oauthKind(provider);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT auth_cipher FROM user_subscription_credentials WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(workspaceId, userId, kind)
    .first<{ auth_cipher: string }>();
  if (!row) return null;
  const plain = await decryptAuthJson(row.auth_cipher, env.MODEL_CREDENTIAL_KEY!, workspaceId, userId, kind);
  return JSON.parse(plain) as UserOAuthRecord;
}

export async function saveUserOAuthRecord(
  env: Env,
  userId: string,
  provider: UserOAuthProvider,
  record: UserOAuthRecord,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  if (!modelCredentialKeyConfigured(env)) {
    throw new Error("MODEL_CREDENTIAL_KEY is not configured.");
  }
  await ensureSubscriptionCredentialSchema(env);
  const kind = oauthKind(provider);
  const cipher = await encryptAuthJson(
    JSON.stringify(record),
    env.MODEL_CREDENTIAL_KEY!,
    workspaceId,
    userId,
    kind,
  );
  const emailHash =
    record.email !== undefined
      ? await crypto.subtle
          .digest("SHA-256", new TextEncoder().encode(record.email))
          .then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""))
      : null;
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
    .bind(workspaceId, userId, kind, cipher, emailHash, record.expiresAt, Date.now())
    .run();
}

export async function deleteUserOAuthRecord(
  env: Env,
  userId: string,
  provider: UserOAuthProvider,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  await ensureSubscriptionCredentialSchema(env);
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM user_subscription_credentials WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(workspaceId, userId, oauthKind(provider))
    .run();
}

export function userProviderOAuthReady(env: Pick<Env, "MODEL_CREDENTIAL_KEY" | "UserProviderOAuth">): boolean {
  return modelCredentialKeyConfigured(env) && env.UserProviderOAuth !== undefined;
}

function pendingFieldKind(provider: UserOAuthProvider, field: string): string {
  return `oauth-pending:${provider}:${field}`;
}

export async function sealOAuthPendingField(
  env: Env,
  userId: string,
  provider: UserOAuthProvider,
  field: string,
  plaintext: string,
): Promise<string> {
  if (!modelCredentialKeyConfigured(env)) {
    throw new Error("MODEL_CREDENTIAL_KEY is not configured.");
  }
  return encryptAuthJson(
    plaintext,
    env.MODEL_CREDENTIAL_KEY!,
    DEFAULT_WORKSPACE_ID,
    userId,
    pendingFieldKind(provider, field),
  );
}

export async function openOAuthPendingField(
  env: Env,
  userId: string,
  provider: UserOAuthProvider,
  field: string,
  cipher: string,
): Promise<string> {
  if (!modelCredentialKeyConfigured(env)) {
    throw new Error("MODEL_CREDENTIAL_KEY is not configured.");
  }
  return decryptAuthJson(
    cipher,
    env.MODEL_CREDENTIAL_KEY!,
    DEFAULT_WORKSPACE_ID,
    userId,
    pendingFieldKind(provider, field),
  );
}

export async function userOAuthStatus(
  env: Env,
  userId: string,
  provider: UserOAuthProvider,
): Promise<{ connected: boolean; expiresAt?: number }> {
  const record = await loadUserOAuthRecord(env, userId, provider);
  if (!record) return { connected: false };
  return { connected: true, expiresAt: record.expiresAt };
}
