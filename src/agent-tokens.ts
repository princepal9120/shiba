/**
 * Agent token store (megaplan task 4): per-agent bearer tokens for the
 * `/mcp` gateway (T5), backed by the `AGENT_TOKENS` KV namespace.
 *
 * Storage: the raw token is hashed with SHA-256 and the record lives under
 * `tok_<sha256hex>` — the token itself is never stored, so a KV read (an
 * admin listing, a dumped backup) cannot mint a working bearer. The raw
 * token is returned exactly once by {@link createToken}.
 *
 * Deny-by-default: {@link verifyToken} answers null for malformed, unknown,
 * or revoked tokens — and for a KV outage, which must deny like an unknown
 * token rather than throw a 500 into the `/mcp` handler; {@link requireScope}
 * throws {@link ScopeError} on a missing scope so the gateway can map it to
 * a 403-class JSON-RPC error.
 */
import { randomHex } from "./mailbox-store.js";
import { InputError, redactSecrets } from "./security.js";

export const SCOPES = [
  "email:read",
  "email:draft",
  "email:send",
  "email:delete",
  "memory:read",
  "memory:write",
  "sandbox:exec",
  "admin:tokens",
] as const;
export type Scope = (typeof SCOPES)[number];

/** Missing-scope failure — the gateway maps this to a 403-class response. */
export class ScopeError extends Error {
  readonly code = "missing_scope";
  constructor(
    readonly scope: string,
    principal: string,
  ) {
    super(`principal "${principal}" is missing scope "${scope}".`);
    this.name = "ScopeError";
  }
}

/**
 * What KV holds per token. The raw token is deliberately absent — only its
 * SHA-256 (in the key) is needed to find this record again.
 */
export interface TokenRecord {
  principal: string;
  scopes: Scope[];
  /** Epoch milliseconds. */
  created: number;
  revoked: boolean;
}

/** Narrow env surface — the KV binding wired in wrangler.jsonc. */
export interface AgentTokensEnv {
  AGENT_TOKENS: KVNamespace;
}

/** Storage key prefix so token records can be listed without a registry. */
export const TOKEN_PREFIX = "tok_";

const TOKEN_ID_BYTES = 8;
const TOKEN_SECRET_BYTES = 24;
// shb_<16-hex id>_<48-hex secret> — verified shape-checked before any KV read.
const TOKEN_RE = /^shb_[0-9a-f]{16}_[0-9a-f]{48}$/;
const MAX_PRINCIPAL_LENGTH = 128;

/** SHA-256 hex of a string — WebCrypto, runs in Workers and Node. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hex of a raw bearer token — the value that keys its record. */
export async function hashToken(rawToken: string): Promise<string> {
  return sha256Hex(rawToken);
}

/** KV key for a raw bearer token: `tok_<sha256(token)>`. */
async function tokenKey(rawToken: string): Promise<string> {
  return `${TOKEN_PREFIX}${await hashToken(rawToken)}`;
}

/**
 * Shape-check a KV payload. Anything that is not a well-formed record is
 * treated as a miss — a corrupted entry must not mint a working token.
 * Parsing happens here (not KV `type: "json"`, which throws on malformed
 * payloads) so corruption denies cleanly instead of erroring the caller.
 */
function parseRecord(value: unknown): TokenRecord | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.principal !== "string" ||
    !Array.isArray(record.scopes) ||
    !record.scopes.every((s) => typeof s === "string") ||
    typeof record.created !== "number" ||
    typeof record.revoked !== "boolean"
  ) {
    return null;
  }
  return {
    principal: record.principal,
    scopes: record.scopes as Scope[],
    created: record.created,
    revoked: record.revoked,
  };
}

/**
 * KV read that fails closed: a store outage resolves to `null` (a miss),
 * never a thrown error — auth callers deny instead of surfacing a 500.
 * The warning keeps the outage visible in logs.
 */
async function kvGet(env: AgentTokensEnv, key: string): Promise<string | null> {
  try {
    return await env.AGENT_TOKENS.get(key, { type: "text" });
  } catch (error: unknown) {
    console.warn(
      `agent-tokens: KV get failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return null;
  }
}

async function readRecord(env: AgentTokensEnv, rawToken: string): Promise<TokenRecord | null> {
  return parseRecord(await kvGet(env, await tokenKey(rawToken)));
}

/**
 * Mint a new token for `principal`. The full `shb_…` string is returned
 * once and never written anywhere — store it at the caller, lose it, and
 * the only recovery is a fresh token.
 */
export async function createToken(
  env: AgentTokensEnv,
  principal: string,
  scopes: readonly string[],
  nowMs?: number,
): Promise<{ token: string; record: TokenRecord }> {
  const name = principal.trim();
  if (name === "" || name.length > MAX_PRINCIPAL_LENGTH || /\s/.test(name)) {
    throw new InputError("principal must be a non-empty name without whitespace.");
  }
  const unique = [...new Set(scopes)];
  if (unique.length === 0) {
    throw new InputError("a token must grant at least one scope.");
  }
  for (const scope of unique) {
    if (!(SCOPES as readonly string[]).includes(scope)) {
      throw new InputError(`unknown scope "${scope}".`);
    }
  }
  const token = `shb_${randomHex(TOKEN_ID_BYTES)}_${randomHex(TOKEN_SECRET_BYTES)}`;
  const record: TokenRecord = {
    principal: name,
    scopes: unique as Scope[],
    created: nowMs ?? Date.now(),
    revoked: false,
  };
  await env.AGENT_TOKENS.put(await tokenKey(token), JSON.stringify(record));
  return { token, record };
}

/**
 * Resolve a bearer token to its record, or null for a malformed token,
 * an unknown token, a revoked one, or an unreachable store — callers
 * never learn which.
 */
export async function verifyToken(
  env: AgentTokensEnv,
  bearer: string,
): Promise<TokenRecord | null> {
  if (!TOKEN_RE.test(bearer)) {
    return null;
  }
  const record = await readRecord(env, bearer);
  if (!record || record.revoked) {
    return null;
  }
  return record;
}

/**
 * Revoke by raw token: flips `revoked` on the stored record and returns it,
 * or null when the token is malformed/unknown or the store cannot be
 * reached — a failed revoke reports failure, never claims a dead token.
 * Idempotent — revoking an already-revoked token returns the same record
 * without a KV write.
 */
export async function revokeToken(
  env: AgentTokensEnv,
  bearer: string,
): Promise<TokenRecord | null> {
  if (!TOKEN_RE.test(bearer)) {
    return null;
  }
  const key = await tokenKey(bearer);
  const record = parseRecord(await kvGet(env, key));
  if (!record) {
    return null;
  }
  if (!record.revoked) {
    record.revoked = true;
    try {
      await env.AGENT_TOKENS.put(key, JSON.stringify(record));
    } catch (error: unknown) {
      console.warn(
        `agent-tokens: KV put failed during revoke: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      );
      return null;
    }
  }
  return record;
}

/**
 * Every stored record (revoked included), oldest first — admin surface.
 * A store failure mid-pagination warns and returns the records collected
 * so far rather than throwing into the admin route.
 */
export async function listTokens(env: AgentTokensEnv): Promise<TokenRecord[]> {
  const records: TokenRecord[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await env.AGENT_TOKENS.list({ prefix: TOKEN_PREFIX, cursor });
      for (const key of page.keys) {
        const record = parseRecord(await kvGet(env, key.name));
        if (record) {
          records.push(record);
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
  } catch (error: unknown) {
    console.warn(
      `agent-tokens: KV list failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
  }
  return records.sort((a, b) => a.created - b.created);
}

export function hasScope(record: TokenRecord | null | undefined, scope: Scope): boolean {
  return record?.scopes.includes(scope) ?? false;
}

/**
 * Throw {@link ScopeError} unless `record` holds `scope` — a null record
 * fails the same way, so an unauthenticated caller cannot widen into a
 * granted principal by accident.
 */
export function requireScope(record: TokenRecord | null, scope: Scope): void {
  if (!hasScope(record, scope)) {
    throw new ScopeError(scope, record?.principal ?? "<unknown>");
  }
}
