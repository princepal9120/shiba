/**
 * T29 — OAuth 2.1 authorization server for `/mcp` (PLAN.md §18.7).
 *
 * Third-party MCP clients (Claude Code, Codex, Cursor) discover and talk
 * OAuth — a static `shb_` bearer is the documented owner path and stays
 * working unchanged; this module adds the protocol surface:
 *
 *   GET  /.well-known/oauth-authorization-server   (RFC 8414)
 *   GET  /.well-known/oauth-protected-resource     (RFC 9728)
 *   POST /oauth/register                           (RFC 7591, public clients)
 *   GET/POST /oauth/authorize                      (code + PKCE S256 only)
 *   POST /oauth/token                              (code exchange + refresh)
 *   POST /oauth/revoke                             (RFC 7009)
 *
 * Storage: same AGENT_TOKENS KV as static tokens, hashed keys — a KV dump
 * mints nothing. Codes are single-use and expire in 10 minutes; access
 * tokens live 1 hour; refresh tokens live 30 days and rotate on every use
 * (a reused rotated refresh record is revoked, not replayed).
 *
 * Invariants (CLAUDE.md): the approval gate is untouched — OAuth records
 * resolve to the same TokenRecord shape the requireScope registry already
 * reads; the client-supplied MCP_PRINCIPAL_HEADER strip is unchanged; no
 * token, code, or secret ever appears in a URL query, a log line, or a UI
 * response body; issuance endpoints are rate-limited and audited.
 */
import {
  sha256Hex, hasScope, verifyToken, SCOPES,
  type Scope, type TokenRecord, type AgentTokensEnv,
} from "./agent-tokens.js";
import { audit, type AuditEnv } from "./audit.js";
import { randomHex } from "./mailbox-store.js";
import { redactSecrets } from "./security.js";

// ---------------------------------------------------------------------------
// Shapes

interface ClientRecord {
  name: string;
  redirectUris: string[];
  created: number;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: Scope[];
  owner: string;
  expiresAt: number;
}

interface AccessRecord {
  principal: string;
  scopes: Scope[];
  created: number;
  expiresAt: number;
  revoked: boolean;
  clientId: string;
}

interface RefreshRecord {
  principal: string;
  scopes: Scope[];
  created: number;
  expiresAt: number;
  revoked: boolean;
  clientId: string;
}

/**
 * The binding between the rendered consent form and the code-minting
 * submit: GET mints this record keyed by the hidden field's hash, POST
 * must present the token and still match every frozen field.
 */
interface ConsentRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: Scope[];
  owner: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Constants

const CLIENT_PREFIX = "oauth_client_";
const CODE_PREFIX = "oauth_code_";
const ACCESS_PREFIX = "oauth_at_";
const REFRESH_PREFIX = "oauth_rt_";
const RATE_PREFIX = "oauth_rate_";
const CONSENT_PREFIX = "oauth_consent_";

const CODE_TTL_MS = 10 * 60 * 1000;
/** The consent form's window — same expiry as the code it can mint. */
const CONSENT_TTL_MS = CODE_TTL_MS;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Issuance endpoints: 20 hits per client IP per hour, KV-bucketed. */
const ISSUE_RATE_LIMIT = 20;
const ISSUE_RATE_WINDOW_MS = 60 * 60 * 1000;

const ACCESS_TOKEN_RE = /^sho_[0-9a-f]{16}_[0-9a-f]{48}$/;
const REFRESH_TOKEN_RE = /^shr_[0-9a-f]{16}_[0-9a-f]{48}$/;
const S256_RE = /^[A-Za-z0-9_-]{43}$/;

export interface OAuthEnv extends AgentTokensEnv, AuditEnv {
  AGENT_TOKENS: KVNamespace;
}

// ---------------------------------------------------------------------------
// KV helpers — every read fails closed like agent-tokens.

async function kvGet(env: OAuthEnv, key: string): Promise<unknown> {
  try {
    const raw = await env.AGENT_TOKENS.get(key, { type: "text" });
    return raw === null ? null : JSON.parse(raw);
  } catch (error) {
    console.warn(`oauth: KV get failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return null;
  }
}

async function kvPut(env: OAuthEnv, key: string, value: unknown, ttlMs?: number): Promise<void> {
  await env.AGENT_TOKENS.put(
    key,
    JSON.stringify(value),
    ttlMs !== undefined ? { expirationTtl: Math.ceil(ttlMs / 1000) } : undefined,
  );
}

function asRecord<T extends object>(value: unknown, required: readonly string[]): T | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const field of required) {
    if (!(field in record)) return null;
  }
  return record as unknown as T;
}

// ---------------------------------------------------------------------------
// Rate limit — a KV minute bucket per caller. A KV outage denies issuance
// (fail closed), matching verifyToken's posture.

async function rateLimited(env: OAuthEnv, bucket: string): Promise<boolean> {
  const key = `${RATE_PREFIX}${await sha256Hex(bucket)}`;
  const now = Date.now();
  const window = Math.floor(now / ISSUE_RATE_WINDOW_MS);
  const windowKey = `${key}_${window}`;
  try {
    const raw = await env.AGENT_TOKENS.get(windowKey, { type: "text" });
    const count = raw === null ? 0 : Number.parseInt(raw, 10);
    if (!Number.isFinite(count) || count >= ISSUE_RATE_LIMIT) return true;
    await env.AGENT_TOKENS.put(windowKey, String(count + 1), {
      expirationTtl: Math.ceil((ISSUE_RATE_WINDOW_MS * 2) / 1000),
    });
    return false;
  } catch {
    return true;
  }
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
}

function jsonError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status });
}

// ---------------------------------------------------------------------------
// Discovery

function issuer(request: Request): string {
  return new URL(request.url).origin;
}

function handleDiscovery(request: Request, pathname: string): Response | null {
  const origin = issuer(request);
  if (pathname === "/.well-known/oauth-authorization-server") {
    return Response.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...SCOPES],
    });
  }
  if (pathname === "/.well-known/oauth-protected-resource") {
    return Response.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591) — public clients only.

function isLoopbackUri(uri: URL): boolean {
  return uri.protocol === "http:" && (uri.hostname === "localhost" || uri.hostname === "127.0.0.1" || uri.hostname === "::1");
}

function validateRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    return null;
  }
  // Public MCP clients redirect to https or a loopback http listener.
  // Anything else (custom schemes, file:, data:) is refused — the
  // redirect URI is where a code lands, and a code IS a credential in
  // transit, so plain http beyond loopback is never acceptable.
  if (uri.protocol !== "https:" && !isLoopbackUri(uri)) return null;
  if (uri.hash !== "") return null;
  return uri.toString();
}

async function handleRegister(request: Request, env: OAuthEnv): Promise<Response> {
  if (await rateLimited(env, `register:${clientIp(request)}`)) {
    return jsonError(429, "rate_limited", "Too many registrations from this address.");
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid_client_metadata", "Body must be a JSON object.");
  }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 8) {
    return jsonError(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array (max 8).");
  }
  const cleaned: string[] = [];
  for (const uri of redirectUris) {
    const valid = validateRedirectUri(uri);
    if (valid === null) return jsonError(400, "invalid_redirect_uri", "redirect_uris must be https: or loopback http: without fragments.");
    cleaned.push(valid);
  }
  const requestedScopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [];
  for (const scope of requestedScopes) {
    if (!(SCOPES as readonly string[]).includes(scope)) {
      return jsonError(400, "invalid_client_metadata", `unknown scope "${scope}".`);
    }
  }
  const record: ClientRecord = {
    name: typeof body.client_name === "string" ? body.client_name.slice(0, 128) : "mcp-client",
    redirectUris: cleaned,
    created: Date.now(),
  };
  const clientId = `shc_${randomHex(16)}`;
  await kvPut(env, `${CLIENT_PREFIX}${clientId}`, record);
  await audit(env, {
    principal: "oauth", tool: "oauth.register",
    argsHash: await sha256Hex(`${clientId}:${record.name}`), outcome: "ok",
  });
  return Response.json({
    client_id: clientId,
    client_id_issued_at: Math.floor(record.created / 1000),
    client_name: record.name,
    redirect_uris: record.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(requestedScopes.length > 0 ? { scope: requestedScopes.join(" ") } : {}),
  }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Authorization — owner consent mints a single-use code.

function parseScopes(raw: string | null): Scope[] | null {
  const scopes = (raw ?? "").split(/\s+/).filter(Boolean);
  if (scopes.length === 0) return null;
  for (const scope of scopes) {
    if (!(SCOPES as readonly string[]).includes(scope)) return null;
  }
  return scopes as Scope[];
}

function consentPage(clientName: string, scopes: Scope[], action: string, consent: string): string {
  const list = scopes.map((s) => `<li><code>${s}</code></li>`).join("");
  return `<!doctype html><html><body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
<h1>Authorize ${escapeHtml(clientName)}?</h1>
<p>This MCP client requests these scopes:</p><ul>${list}</ul>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="consent" value="${escapeHtml(consent)}">
<button type="submit" name="confirm" value="yes">Approve</button>
</form>
<p>Approving issues a single-use authorization code to the client's redirect URI.</p>
</body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

async function handleAuthorize(request: Request, env: OAuthEnv, ownerId: string | null): Promise<Response> {
  const url = new URL(request.url);
  // The consent form POSTs its fields in the body but keeps the original
  // OAuth params in the action URL — merge both, body wins.
  const params = new URLSearchParams(url.searchParams);
  if (request.method === "POST") {
    const body = new URLSearchParams(await request.text());
    body.forEach((value, key) => params.set(key, value));
  }

  const clientId = params.get("client_id") ?? "";
  const client = asRecord<ClientRecord>(await kvGet(env, `${CLIENT_PREFIX}${clientId}`), ["name", "redirectUris", "created"]);
  if (!client) return jsonError(400, "invalid_request", "unknown client_id.");
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!client.redirectUris.includes(redirectUri)) {
    return jsonError(400, "invalid_request", "redirect_uri is not registered for this client.");
  }
  const scopes = parseScopes(params.get("scope"));
  if (scopes === null) return jsonError(400, "invalid_scope", "scope must be a non-empty subset of the registered scopes.");
  if (params.get("response_type") !== "code") return jsonError(400, "unsupported_response_type", "only code is supported.");
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !S256_RE.test(challenge)) {
    return jsonError(400, "invalid_request", "code_challenge with S256 is required.");
  }

  // The owner approves: Cloudflare Access identity when the deployment has
  // it, else an admin:tokens bearer in the Authorization header (never the
  // URL — a code/credential in a URL is a log leak).
  let owner = ownerId;
  if (owner === null) {
    const admin = request.headers.get("authorization");
    if (admin?.toLowerCase().startsWith("bearer ")) {
      const record = await verifyToken(env, admin.slice(7).trim());
      if (record && hasScope(record, "admin:tokens")) owner = `owner:${record.principal}`;
    }
  }
  if (owner === null) {
    return new Response("Owner authentication required to authorize an MCP client.", { status: 403 });
  }

  if (request.method === "GET") {
    const action = `${url.pathname}?${params.toString()}`;
    // The consent token binds the approve POST to this exact request and
    // owner — without it a third-party page could submit the form on a
    // signed-in owner's behalf (the ambient Access/better-auth identity
    // rides along automatically). It lives in a hidden field, never the
    // URL, and its KV key is the token's hash like every secret here.
    const consent = randomHex(32);
    const consentRecord: ConsentRecord = {
      clientId, redirectUri, codeChallenge: challenge, scopes,
      owner, expiresAt: Date.now() + CONSENT_TTL_MS,
    };
    await kvPut(env, `${CONSENT_PREFIX}${await sha256Hex(consent)}`, consentRecord, CONSENT_TTL_MS);
    return new Response(consentPage(client.name, scopes, action, consent), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  // The rendered form's single-use token must come back with the submit.
  // It is consumed before any check so a replayed or forged POST mints
  // nothing, and every field the form froze must still match — a token
  // minted for one request cannot approve another.
  const consentKey = `${CONSENT_PREFIX}${await sha256Hex(params.get("consent") ?? "")}`;
  const consent = asRecord<ConsentRecord>(await kvGet(env, consentKey), [
    "clientId",
    "redirectUri",
    "codeChallenge",
    "scopes",
    "owner",
    "expiresAt",
  ]);
  if (consent !== null) {
    try { await env.AGENT_TOKENS.delete(consentKey); } catch { /* deny below */ }
  }
  if (
    consent === null ||
    !Array.isArray(consent.scopes) ||
    consent.clientId !== clientId ||
    consent.redirectUri !== redirectUri ||
    consent.codeChallenge !== challenge ||
    consent.owner !== owner ||
    consent.expiresAt < Date.now() ||
    consent.scopes.join(" ") !== scopes.join(" ")
  ) {
    return jsonError(400, "invalid_request", "consent token is missing, mismatched, or expired.");
  }
  if (params.get("confirm") !== "yes") {
    return new Response("Authorization was not confirmed.", { status: 400 });
  }

  if (await rateLimited(env, `authorize:${owner}`)) {
    return jsonError(429, "rate_limited", "Too many authorization requests.");
  }

  const code = randomHex(32);
  const record: CodeRecord = {
    clientId, redirectUri, codeChallenge: challenge, scopes,
    owner, expiresAt: Date.now() + CODE_TTL_MS,
  };
  // Code rides the 302 Location per the spec — the KV key is its hash, so a
  // store read can never replay it, and it is deleted on redemption.
  await kvPut(env, `${CODE_PREFIX}${await sha256Hex(code)}`, record, CODE_TTL_MS);
  await audit(env, {
    principal: owner, tool: "oauth.authorize",
    argsHash: await sha256Hex(`${clientId}:${scopes.join(" ")}`), outcome: "ok",
  });
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (params.get("state") !== null) redirect.searchParams.set("state", params.get("state") ?? "");
  return new Response(null, { status: 302, headers: { location: redirect.toString() } });
}

// ---------------------------------------------------------------------------
// Token exchange + refresh rotation.

async function issueTokenPair(
  env: OAuthEnv,
  clientId: string,
  owner: string,
  scopes: Scope[],
): Promise<Response> {
  const access = `sho_${randomHex(8)}_${randomHex(24)}`;
  const refresh = `shr_${randomHex(8)}_${randomHex(24)}`;
  const now = Date.now();
  const principal = `oauth:${clientId}:${owner}`;
  await kvPut(env, `${ACCESS_PREFIX}${await sha256Hex(access)}`, {
    principal, scopes, created: now, expiresAt: now + ACCESS_TOKEN_TTL_MS, revoked: false, clientId,
  } satisfies AccessRecord, ACCESS_TOKEN_TTL_MS);
  await kvPut(env, `${REFRESH_PREFIX}${await sha256Hex(refresh)}`, {
    principal, scopes, created: now, expiresAt: now + REFRESH_TOKEN_TTL_MS, revoked: false, clientId,
  } satisfies RefreshRecord, REFRESH_TOKEN_TTL_MS);
  await audit(env, {
    principal, tool: "oauth.token",
    argsHash: await sha256Hex(`${clientId}`), outcome: "ok",
  });
  return Response.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refresh,
    scope: scopes.join(" "),
  });
}

async function handleToken(request: Request, env: OAuthEnv): Promise<Response> {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await request.text());
  } catch {
    return jsonError(400, "invalid_request", "form-encoded body required.");
  }
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const verifier = params.get("code_verifier") ?? "";
    if (!code || !clientId || !verifier) {
      return jsonError(400, "invalid_request", "code, client_id and code_verifier are required.");
    }
    const key = `${CODE_PREFIX}${await sha256Hex(code)}`;
    const record = asRecord<CodeRecord>(await kvGet(env, key), ["clientId", "codeChallenge", "expiresAt"]);
    // Single-use: a redeemed code is deleted before any further check so a
    // concurrent replay races the delete, not the verify.
    if (record !== null) {
      try { await env.AGENT_TOKENS.delete(key); } catch { /* deny below */ }
    }
    if (record === null || record.clientId !== clientId || record.redirectUri !== redirectUri || record.expiresAt < Date.now()) {
      return jsonError(400, "invalid_grant", "code is unknown, mismatched, or expired.");
    }
    const computed = await s256(verifier);
    if (computed !== record.codeChallenge) {
      await audit(env, {
        principal: `oauth:${clientId}`, tool: "oauth.token",
        argsHash: await sha256Hex(clientId), outcome: "denied", detail: "pkce_mismatch",
      });
      return jsonError(400, "invalid_grant", "code_verifier does not match.");
    }
    return issueTokenPair(env, clientId, record.owner, record.scopes);
  }

  if (grantType === "refresh_token") {
    const refresh = params.get("refresh_token") ?? "";
    if (!REFRESH_TOKEN_RE.test(refresh)) {
      return jsonError(400, "invalid_grant", "unknown refresh token.");
    }
    const key = `${REFRESH_PREFIX}${await sha256Hex(refresh)}`;
    const record = asRecord<RefreshRecord>(await kvGet(env, key), ["principal", "expiresAt", "revoked", "clientId"]);
    if (record === null || record.revoked || record.expiresAt < Date.now()) {
      return jsonError(400, "invalid_grant", "refresh token is unknown, revoked, or expired.");
    }
    // Rotation: the presented refresh is revoked in the same breath as the
    // new pair is minted — a refresh token is used exactly once.
    record.revoked = true;
    await kvPut(env, key, record, REFRESH_TOKEN_TTL_MS);
    return issueTokenPair(env, record.clientId, record.principal.replace(/^oauth:[^:]+:/, ""), record.scopes);
  }

  return jsonError(400, "unsupported_grant_type", "authorization_code and refresh_token are supported.");
}

/** S256: base64url(SHA-256(verifier)) — no padding. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Revocation (RFC 7009) — always 200, never reveals whether a token existed.

async function handleRevoke(request: Request, env: OAuthEnv): Promise<Response> {
  const params = new URLSearchParams(await request.text());
  const token = params.get("token") ?? "";
  const prefix = REFRESH_TOKEN_RE.test(token) ? REFRESH_PREFIX : ACCESS_TOKEN_RE.test(token) ? ACCESS_PREFIX : null;
  if (prefix !== null) {
    const key = `${prefix}${await sha256Hex(token)}`;
    const record = asRecord<AccessRecord>(await kvGet(env, key), ["revoked"]);
    if (record !== null && !record.revoked) {
      record.revoked = true;
      await kvPut(env, key, record);
    }
    await audit(env, {
      principal: "oauth", tool: "oauth.revoke",
      argsHash: await sha256Hex(prefix), outcome: "ok",
    });
  }
  return new Response(null, { status: 200 });
}

// ---------------------------------------------------------------------------
// Access-token verify — resolves an `sho_` bearer to the TokenRecord shape
// the MCP registry already gates on. Fails closed like verifyToken.

export async function verifyOAuthAccessToken(env: OAuthEnv, bearer: string): Promise<TokenRecord | null> {
  if (!ACCESS_TOKEN_RE.test(bearer)) return null;
  const record = asRecord<AccessRecord>(await kvGet(env, `${ACCESS_PREFIX}${await sha256Hex(bearer)}`),
    ["principal", "scopes", "expiresAt", "revoked"]);
  if (record === null || record.revoked || record.expiresAt < Date.now()) return null;
  return { principal: record.principal, scopes: record.scopes, created: record.created, revoked: false };
}

// ---------------------------------------------------------------------------
// Router — returns null for paths this module does not own.

export async function handleOAuth(request: Request, env: OAuthEnv, ownerId: string | null): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const discovery = handleDiscovery(request, pathname);
  if (discovery) return discovery;
  try {
    if (pathname === "/oauth/register" && request.method === "POST") return await handleRegister(request, env);
    if (pathname === "/oauth/authorize" && (request.method === "GET" || request.method === "POST")) {
      return await handleAuthorize(request, env, ownerId);
    }
    if (pathname === "/oauth/token" && request.method === "POST") return await handleToken(request, env);
    if (pathname === "/oauth/revoke" && request.method === "POST") return await handleRevoke(request, env);
  } catch (error) {
    console.warn(`oauth: handler failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return jsonError(500, "server_error", "OAuth request failed.");
  }
  return null;
}
