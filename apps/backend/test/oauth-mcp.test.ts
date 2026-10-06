/**
 * T29 — OAuth 2.1 authorization server on /mcp (PLAN.md §18.7).
 *
 * Pins: discovery documents; RFC 7591 public-client registration with
 * redirect-URI validation; authorize → consent → single-use code →
 * S256-checked exchange → rotating refresh; revoked and expired tokens
 * refused; grant issuance rate-limited and audited; the MCP bearer path
 * resolves `sho_` records to the same TokenRecord the registry gates on.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => new Response("{}", { status: 404 }) }),
  routeAgentRequest: async () => null,
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("agents/mcp", () => ({
  createMcpHandler: () => ({ fetch: async () => Response.json({ mcp: "served" }), notify: {} }),
}));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { createToken } from "../src/agent-tokens.js";
import { handleOAuth, verifyOAuthAccessToken } from "../src/oauth-mcp.js";

class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list() {
    return { keys: [], list_complete: true, cursor: "", cacheStatus: null };
  }
}

class FakeD1 {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  prepare(sql: string) {
    const calls = this.calls;
    return {
      run: async () => { calls.push({ sql, params: [] }); return { success: true }; },
      bind: (...params: unknown[]) => ({
        run: async () => { calls.push({ sql, params }); return { success: true }; },
      }),
    };
  }
}

function makeEnv() {
  const kv = new FakeKV();
  const d1 = new FakeD1();
  const env = {
    AGENT_TOKENS: kv as unknown as KVNamespace,
    AGENT_AUDIT: d1 as unknown as D1Database,
  } as unknown as Env;
  return { env, kv, d1 };
}

const ORIGIN = "https://worker.example.com";
const OWNER = "owner@example.com";
const REDIRECT = "http://localhost:8787/callback";

async function register(env: Env, redirectUri = REDIRECT) {
  const response = await handleOAuth(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "test-client", redirect_uris: [redirectUri] }),
    }),
    env, null,
  );
  return { response, body: (await response!.json()) as Record<string, unknown> };
}

async function shaB64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function authorizeParams(clientId: string, challenge: string): URLSearchParams {
  return new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256",
    scope: "runs:read email:read", state: "s1",
  });
}

async function consentToken(env: Env, params: URLSearchParams, owner: string | null = OWNER) {
  // GET mints the single-use token bound to this exact request + owner and
  // renders it into the form's hidden field — POST must present it back.
  const get = await handleOAuth(new Request(`${ORIGIN}/oauth/authorize?${params}`), env, owner);
  const html = await get!.text();
  return { get, consent: /name="consent" value="([^"]+)"/.exec(html)?.[1] };
}

async function authorizePost(env: Env, clientId: string, verifier: string, owner: string | null = OWNER) {
  const params = authorizeParams(clientId, await shaB64(verifier));
  const { consent } = await consentToken(env, params, owner);
  return handleOAuth(
    new Request(`${ORIGIN}/oauth/authorize?${params}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ confirm: "yes", ...(consent !== undefined ? { consent } : {}) }).toString(),
    }),
    env, owner,
  );
}

async function exchange(env: Env, clientId: string, code: string, verifier: string) {
  return handleOAuth(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: clientId,
        redirect_uri: REDIRECT, code, code_verifier: verifier,
      }).toString(),
    }),
    env, null,
  );
}

async function fullGrant(env: Env) {
  const { body } = await register(env);
  const clientId = body.client_id as string;
  const verifier = "v".repeat(64);
  const auth = await authorizePost(env, clientId, verifier);
  const code = new URL(auth!.headers.get("location")!).searchParams.get("code")!;
  const tokenResponse = await exchange(env, clientId, code, verifier);
  return { clientId, token: (await tokenResponse!.json()) as Record<string, unknown> };
}

describe("discovery", () => {
  it("serves the authorization-server and protected-resource documents", async () => {
    const { env } = makeEnv();
    const as = await handleOAuth(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env, null);
    const meta = (await as!.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    const pr = await handleOAuth(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), env, null);
    expect(((await pr!.json()) as Record<string, unknown>).resource).toBe(`${ORIGIN}/mcp`);
  });
});

describe("register", () => {
  it("mints a public client and echoes the OAuth profile", async () => {
    const { env } = makeEnv();
    const { response, body } = await register(env);
    expect(response!.status).toBe(201);
    expect(body.client_id).toMatch(/^shc_[0-9a-f]+$/);
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("refuses non-https, non-loopback, and fragment-bearing redirect URIs", async () => {
    const { env } = makeEnv();
    for (const bad of ["http://evil.example.com/cb", "file:///etc/passwd", "https://ok.example.com/cb#frag"]) {
      const { response } = await register(env, bad);
      expect(response!.status).toBe(400);
    }
  });
});

describe("authorize + exchange", () => {
  it("GET renders a consent page; POST confirms → 302 with a code and state", async () => {
    const { env } = makeEnv();
    const { body } = await register(env);
    const get = await handleOAuth(
      new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: body.client_id as string, redirect_uri: REDIRECT,
        code_challenge: await shaB64("x".repeat(64)), code_challenge_method: "S256", scope: "runs:read",
      })}`),
      env, OWNER,
    );
    expect(get!.headers.get("content-type")).toContain("text/html");
    const post = await authorizePost(env, body.client_id as string, "v".repeat(64));
    expect(post!.status).toBe(302);
    const location = new URL(post!.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("s1");
    expect(location.searchParams.get("code")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses consent without an owner identity or an admin:tokens bearer", async () => {
    const { env } = makeEnv();
    const { body } = await register(env);
    const denied = await authorizePost(env, body.client_id as string, "v".repeat(64), null);
    expect(denied!.status).toBe(403);
    // Admin bearer path: the owner alternative for Access-less deploys.
    const admin = await createToken(env, "ops", ["admin:tokens"]);
    const adminParams = authorizeParams(body.client_id as string, await shaB64("v".repeat(64)));
    const adminGet = await handleOAuth(
      new Request(`${ORIGIN}/oauth/authorize?${adminParams}`, {
        headers: { authorization: `Bearer ${admin.token}` },
      }),
      env, null,
    );
    const consent = /name="consent" value="([^"]+)"/.exec(await adminGet!.text())?.[1];
    const confirmed = await handleOAuth(
      new Request(`${ORIGIN}/oauth/authorize?${adminParams}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${admin.token}` },
        body: new URLSearchParams({ confirm: "yes", ...(consent !== undefined ? { consent } : {}) }).toString(),
      }),
      env, null,
    );
    expect(confirmed!.status).toBe(302);
  });

  it("POST without the minted consent token is refused — the form can't be forged", async () => {
    const { env } = makeEnv();
    const { body } = await register(env);
    const params = authorizeParams(body.client_id as string, await shaB64("v".repeat(64)));
    // A third-party page can submit the form on a signed-in owner's behalf
    // only if it holds the token — it can't read the rendered hidden field.
    const forged = await handleOAuth(
      new Request(`${ORIGIN}/oauth/authorize?${params}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "confirm=yes",
      }),
      env, OWNER,
    );
    expect(forged!.status).toBe(400);
    const error = (await forged!.json()) as { error: string };
    expect(error.error).toBe("invalid_request");
  });

  it("the consent token is single-use and bound to the request + owner it was minted for", async () => {
    const { env } = makeEnv();
    const { body } = await register(env);
    const clientId = body.client_id as string;
    const challenge = await shaB64("v".repeat(64));
    const params = authorizeParams(clientId, challenge);
    const post = (p: URLSearchParams, consent: string, owner: string | null = OWNER) =>
      handleOAuth(
        new Request(`${ORIGIN}/oauth/authorize?${p}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ confirm: "yes", consent }).toString(),
        }),
        env, owner,
      );

    const { consent: token } = await consentToken(env, params);
    if (token === undefined) throw new Error("consent field missing from the rendered form");
    // Right request, right token, right owner → code issued…
    expect((await post(params, token))!.status).toBe(302);
    // …and the same token can't mint a second code.
    expect((await post(params, token))!.status).toBe(400);

    // A token minted for one request cannot approve a different one.
    const { consent: token2 } = await consentToken(env, params);
    if (token2 === undefined) throw new Error("consent field missing from the rendered form");
    const otherParams = authorizeParams(clientId, await shaB64("w".repeat(64)));
    expect((await post(otherParams, token2))!.status).toBe(400);

    // Nor can a different owner spend a token minted to someone else.
    const { consent: token3 } = await consentToken(env, params);
    if (token3 === undefined) throw new Error("consent field missing from the rendered form");
    expect((await post(params, token3, "mallory@example.com"))!.status).toBe(400);
  });

  it("rejects an unregistered redirect_uri and unknown scopes", async () => {
    const { env } = makeEnv();
    const { body } = await register(env);
    const challenge = await shaB64("x".repeat(64));
    const badUri = await handleOAuth(
      new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: body.client_id as string,
        redirect_uri: "http://localhost:9999/other", code_challenge: challenge,
        code_challenge_method: "S256", scope: "runs:read",
      })}`, { method: "POST", body: "confirm=yes" }),
      env, OWNER,
    );
    expect(badUri!.status).toBe(400);
    const badScope = await handleOAuth(
      new Request(`${ORIGIN}/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: body.client_id as string, redirect_uri: REDIRECT,
        code_challenge: challenge, code_challenge_method: "S256", scope: "runs:read admin:god",
      })}`, { method: "POST", body: "confirm=yes" }),
      env, OWNER,
    );
    expect(badScope!.status).toBe(400);
  });

  it("issues a token pair on a valid S256 exchange and refuses replays", async () => {
    const { env } = makeEnv();
    const { body } = await register(env);
    const clientId = body.client_id as string;
    const verifier = "v".repeat(64);
    const auth = await authorizePost(env, clientId, verifier);
    const code = new URL(auth!.headers.get("location")!).searchParams.get("code")!;

    const badVerifier = await exchange(env, clientId, code, "wrong".padEnd(64, "w"));
    expect(badVerifier!.status).toBe(400); // invalid_grant AND the code is burned

    const auth2 = await authorizePost(env, clientId, verifier);
    const code2 = new URL(auth2!.headers.get("location")!).searchParams.get("code")!;
    const ok = await exchange(env, clientId, code2, verifier);
    const token = (await ok!.json()) as Record<string, unknown>;
    expect(token.access_token).toMatch(/^sho_/);
    expect(token.refresh_token).toMatch(/^shr_/);
    expect(token.token_type).toBe("Bearer");
    // Single-use: the same code cannot exchange twice.
    const replay = await exchange(env, clientId, code2, verifier);
    expect(replay!.status).toBe(400);
  });

  it("resolves an access token to the gated TokenRecord; revoked and static tokens behave", async () => {
    const { env } = makeEnv();
    const { token } = await fullGrant(env);
    const record = await verifyOAuthAccessToken(env, token.access_token as string);
    expect(record?.principal).toContain("oauth:");
    expect(record?.scopes).toEqual(["runs:read", "email:read"]);
    await handleOAuth(new Request(`${ORIGIN}/oauth/revoke`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: token.access_token as string }).toString(),
    }), env, null);
    expect(await verifyOAuthAccessToken(env, token.access_token as string)).toBeNull();
  });

  it("rotates refresh tokens — the presented one is dead after use", async () => {
    const { env } = makeEnv();
    const { token } = await fullGrant(env);
    const refresh = async (rt: string) => handleOAuth(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }).toString(),
    }), env, null);
    const rotated = (await (await refresh(token.refresh_token as string))!.json()) as Record<string, unknown>;
    expect(rotated.access_token).toMatch(/^sho_/);
    expect(rotated.refresh_token).not.toBe(token.refresh_token);
    // The rotated-out refresh is refused, not replayed.
    expect((await refresh(token.refresh_token as string))!.status).toBe(400);
  });
});

describe("rate limiting + audit", () => {
  it("rate-limits grant issuance and audits the register call", async () => {
    const { env, d1 } = makeEnv();
    for (let i = 0; i < 20; i++) await register(env);
    const over = await register(env);
    expect(over.response!.status).toBe(429);
    expect(d1.calls.some((c) => c.sql.includes("audit_log"))).toBe(true);
  });
});

describe("worker wiring", () => {
  const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

  it("a bare /mcp 401 advertises the protected-resource metadata", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST" }), env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  it("serves discovery documents through the worker unauthenticated", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env, ctx,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).issuer).toBe(ORIGIN);
  });

  it("an OAuth access token authenticates /mcp like a static token", async () => {
    const { env } = makeEnv();
    const { token } = await fullGrant(env);
    const response = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
      }),
      env, ctx,
    );
    expect(response.status).toBe(200);
  });
});
