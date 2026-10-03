/**
 * better-auth lane coverage: config/path predicates, the composed gate
 * (Access ↔ better-auth ↔ fail-closed), and a real end-to-end sign-up /
 * sign-in / sign-out flow through the Worker — the lane runs against a
 * node:sqlite-backed D1 stand-in the same way production runs against
 * AGENT_AUDIT.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  handleBetterAuth,
  isBetterAuthConfigured,
  isBetterAuthPath,
} from "../src/better-auth.js";
import {
  isAuthenticated,
  isAuthorizedRequest,
  resolveUserId,
} from "../src/request-auth.js";

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  proxyToSandbox: vi.fn().mockResolvedValue(null),
  getSandbox: vi.fn(),
}));

vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

const SECRET = "a".repeat(32);
const BASE = "http://localhost:8787";

// node:sqlite statement params accept primitives only — normalize the
// values BA's kysely layer emits the way D1's bind does.
function toBind(value: unknown): null | number | bigint | string | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value as never;
}

/**
 * Minimal D1Database stand-in. Better Auth's adapter detects the D1 shape
 * (`batch`/`exec`/`prepare` present) and drives `prepare().bind().all()`;
 * our schema/hook code uses `prepare().run()` and `.first()`.
 */
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const prepared = (sql: string, params: unknown[]) => ({
    bind: (...args: unknown[]) => prepared(sql, args),
    run: async () => {
      const result = db.prepare(sql).run(...(params.map(toBind) as never[]));
      return {
        results: [],
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid),
        },
      };
    },
    all: async () => ({
      results: db.prepare(sql).all(...(params.map(toBind) as never[])),
      meta: {},
    }),
    first: async () =>
      db.prepare(sql).get(...(params.map(toBind) as never[])) ?? null,
  });
  return {
    prepare: (sql: string) => prepared(sql, []),
    batch: async (stmts: { all: () => Promise<unknown> }[]) =>
      Promise.all(stmts.map((s) => s.all())),
    exec: (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    CodingOrchestrator: {},
    Sandbox: {},
    ASSETS: { fetch: async () => new Response("assets") },
    AGENT_AUDIT: fakeD1(),
    BETTER_AUTH_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function jsonRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
}

/** Sign up the (first) account; returns the session cookie value. */
async function signUp(env: Env, email = "owner@example.com"): Promise<string> {
  const res = await handleBetterAuth(
    jsonRequest("/api/auth/sign-up/email", {
      name: "Owner",
      email,
      password: "password-123",
    }),
    env,
  );
  expect(res?.status).toBe(200);
  const cookie = res!.headers.get("set-cookie");
  expect(cookie).toContain("better-auth.session_token=");
  return cookie!.split(";")[0]!;
}

describe("better-auth lane predicates", () => {
  it("is configured only for a >=32-char secret", () => {
    expect(isBetterAuthConfigured({})).toBe(false);
    expect(isBetterAuthConfigured({ BETTER_AUTH_SECRET: "short" })).toBe(false);
    expect(isBetterAuthConfigured({ BETTER_AUTH_SECRET: "x".repeat(31) })).toBe(false);
    expect(isBetterAuthConfigured({ BETTER_AUTH_SECRET: "x".repeat(32) })).toBe(true);
    expect(isBetterAuthConfigured({ BETTER_AUTH_SECRET: "x".repeat(64) })).toBe(true);
  });

  it("claims /api/auth/* but never the subscription-connect paths", () => {
    expect(isBetterAuthPath("/api/auth/sign-in/email")).toBe(true);
    expect(isBetterAuthPath("/api/auth/sign-up/email")).toBe(true);
    expect(isBetterAuthPath("/api/auth/sign-out")).toBe(true);
    expect(isBetterAuthPath("/api/auth/get-session")).toBe(true);
    expect(isBetterAuthPath("/api/auth")).toBe(false);
    expect(isBetterAuthPath("/api/other")).toBe(false);
    for (const provider of ["claude", "codex", "cursor", "devin", "antigravity"]) {
      expect(isBetterAuthPath(`/api/auth/${provider}-subscription`)).toBe(false);
      expect(isBetterAuthPath(`/api/auth/${provider}-subscription/status`)).toBe(false);
    }
  });
});

describe("gate composition", () => {
  it("stays fail-closed for non-loopback when nothing is configured", () => {
    const env = { ASSETS: {}, CodingOrchestrator: {}, Sandbox: {} } as unknown as Env;
    const request = new Request("https://example.com/api/runs");
    expect(isAuthenticated(request, env)).toBe(false);
    expect(isAuthenticated(new Request("http://localhost/api/runs"), env)).toBe(true);
  });

  it("better-auth mode rejects non-loopback without a session", async () => {
    const env = makeEnv();
    const request = new Request("https://example.com/api/runs");
    expect(isAuthenticated(request, env)).toBe(false);
    expect(await isAuthorizedRequest(request, env)).toBe(false);
    expect(await resolveUserId(request, env)).toBeNull();
  });

  it("exempts /api/auth/* only while the lane is configured", () => {
    const configured = makeEnv();
    expect(
      isAuthenticated(new Request("https://example.com/api/auth/sign-in/email"), configured),
    ).toBe(true);
    const dark = { ...configured, BETTER_AUTH_SECRET: undefined } as unknown as Env;
    expect(isAuthenticated(new Request("https://example.com/api/auth/sign-in/email"), dark)).toBe(false);
    // Subscription-connect paths are never exempted by the lane.
    expect(
      isAuthenticated(new Request("https://example.com/api/auth/claude-subscription"), configured),
    ).toBe(false);
  });
});

describe("worker-level 401 codes", () => {
  async function statusFor(path: string, env: Env): Promise<{ status: number; code: string | null }> {
    const worker = (await import("../src/index.js")).default;
    const res = await worker.fetch(new Request(`https://example.com${path}`), env);
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    return { status: res.status, code: body.code ?? null };
  }

  it("access_not_configured when no identity lane exists", async () => {
    const env = makeEnv({ AGENT_AUDIT: undefined, BETTER_AUTH_SECRET: undefined });
    expect(await statusFor("/api/runs", env)).toEqual({ status: 401, code: "access_not_configured" });
  });

  it("better_auth when only the built-in lane is configured", async () => {
    expect(await statusFor("/api/runs", makeEnv())).toEqual({ status: 401, code: "better_auth" });
  });

  it("serves /api/auth/* before the gate", async () => {
    const worker = (await import("../src/index.js")).default;
    const res = await worker.fetch(
      new Request("https://example.com/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.com" },
        body: JSON.stringify({ email: "nobody@example.com", password: "password-123" }),
      }),
      makeEnv(),
    );
    // Reaches Better Auth (401 invalid-credentials), not the gate's
    // access_not_configured JSON.
    expect(res.status).not.toBe(404);
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    expect(body?.code).not.toBe("access_not_configured");
  });
});

describe("end-to-end session flow", () => {
  it("sign-up → session cookie → whoami → sign-out", async () => {
    const env = makeEnv();
    const worker = (await import("../src/index.js")).default;

    // First sign-up mints the account and a session cookie.
    const cookie = await signUp(env);
    expect(await resolveUserId(new Request(`${BASE}/api/whoami`, { headers: { cookie } }), env)).toBe(
      "owner@example.com",
    );

    // The same cookie authorizes the whole gated surface.
    const whoami = await worker.fetch(new Request(`${BASE}/api/whoami`, { headers: { cookie } }), env);
    expect(whoami.status).toBe(200);
    const identity = (await whoami.json()) as { agent: string; auth: string };
    expect(identity).toEqual({ agent: "owner@example.com", auth: "better-auth" });

    // Sign-out revokes the session — the gate locks again.
    const out = await handleBetterAuth(
      new Request(`${BASE}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin: BASE } }),
      env,
    );
    expect(out?.status).toBe(200);
    const after = await worker.fetch(new Request(`${BASE}/api/whoami`, { headers: { cookie } }), env);
    expect(after.status).toBe(401);
    const denied = (await after.json()) as { code?: string };
    expect(denied.code).toBe("better_auth");
  });

  it("closes sign-up after the first account", async () => {
    const env = makeEnv();
    await signUp(env);
    const res = await handleBetterAuth(
      jsonRequest("/api/auth/sign-up/email", {
        name: "Second",
        email: "second@example.com",
        password: "password-456",
      }),
      env,
    );
    expect(res?.status).toBe(403);
  });

  it("rejects a wrong password and ignores it at the gate", async () => {
    const env = makeEnv();
    await signUp(env);
    const res = await handleBetterAuth(
      jsonRequest("/api/auth/sign-in/email", { email: "owner@example.com", password: "wrong-password" }),
      env,
    );
    expect(res?.status).toBe(401);
    expect(
      await isAuthorizedRequest(new Request(`${BASE}/api/runs`), env),
    ).toBe(false);
  });

  it("is dark without BETTER_AUTH_SECRET (gate semantics preserved)", async () => {
    const env = makeEnv({ BETTER_AUTH_SECRET: undefined });
    const res = await handleBetterAuth(
      jsonRequest("/api/auth/sign-up/email", {
        name: "Owner",
        email: "owner@example.com",
        password: "password-123",
      }),
      env,
    );
    expect(res).toBeNull();
    // …and the gate falls back to fail-closed for non-loopback.
    expect(await isAuthorizedRequest(new Request("https://example.com/api/runs"), env)).toBe(false);
  });

  it("is dark without the AGENT_AUDIT binding (503, never a silent account)", async () => {
    const env = makeEnv({ AGENT_AUDIT: undefined });
    const res = await handleBetterAuth(
      jsonRequest("/api/auth/sign-up/email", {
        name: "Owner",
        email: "owner@example.com",
        password: "password-123",
      }),
      env,
    );
    expect(res?.status).toBe(503);
    expect(await resolveUserId(new Request(`${BASE}/api/whoami`), env)).toBeNull();
  });
});
