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
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

/**
 * The DO surface is exercised through `worker.fetch` with `agents/mcp`
 * stubbed: `McpGateway.serve(...)` records every request the worker would
 * have forwarded to the DO, so tests see both the auth gate and the exact
 * principal header the tool registry will read inside the DO.
 */
const served = vi.hoisted(() => ({ requests: [] as Request[] }));
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve(_path: string, _opts?: unknown) {
      return {
        fetch: async (request: Request) => {
          served.requests.push(request);
          return Response.json({ mcp: "served" }, { status: 200 });
        },
      };
    }
  },
}));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import {
  createToken,
  type AgentTokensEnv,
  type TokenRecord,
} from "../src/agent-tokens.js";
import {
  createToolRegistry,
  hashToolArgs,
  MCP_PRINCIPAL_HEADER,
  principalFor,
} from "../src/mcp-gateway.js";

/** In-memory KV, same fake as the token-store suite. */
class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async list() {
    return { keys: [], list_complete: true, cursor: "", cacheStatus: null };
  }
}

interface D1Call {
  sql: string;
  params: unknown[];
}

/** In-memory D1 recording (sql, params) pairs like the real binding. */
class FakeD1 {
  readonly calls: D1Call[] = [];
  prepare(sql: string) {
    const calls = this.calls;
    return {
      run: async () => {
        calls.push({ sql, params: [] });
        return { success: true, results: [], meta: {} };
      },
      bind: (...params: unknown[]) => ({
        run: async () => {
          calls.push({ sql, params });
          return { success: true, results: [], meta: {} };
        },
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

const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

function mcpRequest(headers: Record<string, string> = {}) {
  return new Request("https://worker/mcp", { method: "POST", headers });
}

describe("/mcp route auth", () => {
  it("answers a plain 401 JSON — not an MCP error — when no token is sent", async () => {
    const { env } = makeEnv();
    served.requests.length = 0;
    const response = await worker.fetch(mcpRequest(), env, ctx);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "Authentication required." });
    // A JSON-RPC-shaped failure would mean the request reached MCP handling.
    expect(body).not.toHaveProperty("jsonrpc");
    expect(served.requests).toHaveLength(0);
  });

  it("401s on malformed and unknown bearers alike", async () => {
    const { env } = makeEnv();
    for (const auth of ["Basic dXNlcjpwYXNz", "Bearer not-a-token", "Bearer"]) {
      served.requests.length = 0;
      const response = await worker.fetch(
        mcpRequest({ authorization: auth }),
        env,
        ctx,
      );
      expect(response.status).toBe(401);
      expect(served.requests).toHaveLength(0);
    }
    served.requests.length = 0;
    const unknown = await worker.fetch(
      mcpRequest({ authorization: `Bearer shb_${"0".repeat(16)}_${"0".repeat(48)}` }),
      env,
      ctx,
    );
    expect(unknown.status).toBe(401);
    expect(served.requests).toHaveLength(0);
  });

  it("forwards verified principals as an injected header the client cannot spoof", async () => {
    const { env } = makeEnv();
    const { token, record } = await createToken(
      env as unknown as AgentTokensEnv,
      "scout",
      ["email:read"],
    );
    const spoof = JSON.stringify({
      principal: "evil",
      scopes: ["admin:tokens"],
      created: 1,
      revoked: false,
    });
    served.requests.length = 0;
    const response = await worker.fetch(
      mcpRequest({ authorization: `Bearer ${token}`, [MCP_PRINCIPAL_HEADER]: spoof }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(served.requests).toHaveLength(1);
    const forwarded = served.requests[0]!;
    // The forwarded request carries the verified record, not the spoof.
    expect(principalFor(forwarded)).toEqual(record);
    expect(principalFor(forwarded)?.principal).toBe("scout");
    expect(forwarded.headers.get(MCP_PRINCIPAL_HEADER)).not.toBe(spoof);
    // The bearer itself still rides along — the transport copies all headers.
    expect(forwarded.headers.get("authorization")).toBe(`Bearer ${token}`);
  });
});

describe("principalFor", () => {
  const record: TokenRecord = {
    principal: "engage",
    scopes: ["memory:read"],
    created: 1_000,
    revoked: false,
  };

  it("returns the injected record and null for absent or corrupt headers", () => {
    const ok = principalFor(
      mcpRequest({ [MCP_PRINCIPAL_HEADER]: JSON.stringify(record) }),
    );
    expect(ok).toEqual(record);
    expect(principalFor(mcpRequest())).toBeNull();
    expect(
      principalFor(mcpRequest({ [MCP_PRINCIPAL_HEADER]: "{not json" })),
    ).toBeNull();
    expect(
      principalFor(
        mcpRequest({
          [MCP_PRINCIPAL_HEADER]: JSON.stringify({ principal: 7, scopes: "x" }),
        }),
      ),
    ).toBeNull();
  });
});

describe("hashToolArgs", () => {
  it("is order-insensitive across nested objects", async () => {
    const a = await hashToolArgs({ b: 1, a: { z: 2, y: [3, { q: 0 }] } });
    const b = await hashToolArgs({ a: { y: [3, { q: 0 }], z: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tool registry", () => {
  const principal: TokenRecord = {
    principal: "scout",
    scopes: ["email:read"],
    created: 1,
    revoked: false,
  };
  const okResult = { content: [{ type: "text" as const, text: "done" }] };

  it("runs a scoped call and audits ok with the hashed args", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    const handler = vi.fn(async () => okResult);
    registry.registerTool("search_emails", "email:read", handler);
    const args = { query: "s3cr3t-token-value", mailbox: "agent@shiba.dev" };
    const result = await registry.invoke("search_emails", args, principal);
    expect(result).toBe(okResult);
    expect(handler).toHaveBeenCalledWith(
      args,
      expect.objectContaining({ env, principal }),
    );
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT"));
    expect(insert).toBeDefined();
    const [, , principal_, tool, argsHash, outcome] = insert!.params;
    expect(principal_).toBe("scout");
    expect(tool).toBe("search_emails");
    // args_hash is a hash of the raw args — the secret value never lands.
    expect(argsHash).toBe(await hashToolArgs(args));
    expect(String(argsHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(argsHash)).not.toContain("s3cr3t");
    expect(outcome).toBe("ok");
  });

  it("denies a missing scope without calling the handler, and audits denied", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    const handler = vi.fn(async () => okResult);
    registry.registerTool("send_email", "email:send", handler);
    const result = await registry.invoke("send_email", { draft_id: "d1" }, principal);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: 'Forbidden: missing scope "email:send".',
    });
    expect(handler).not.toHaveBeenCalled();
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT"))!;
    expect(insert.params[5]).toBe("denied");
    expect(insert.params[2]).toBe("scout");
  });

  it("denies identically when the principal is absent", async () => {
    const { env } = makeEnv();
    const registry = createToolRegistry(env);
    registry.registerTool("search_emails", "email:read", async () => okResult);
    const result = await registry.invoke("search_emails", {}, null);
    expect(result.isError).toBe(true);
  });

  it("audits a thrown handler as error and returns an isError result", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    registry.registerTool("boom", "email:read", async () => {
      throw new Error("store unreachable");
    });
    const result = await registry.invoke("boom", {}, principal);
    expect(result.isError).toBe(true);
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT"))!;
    expect(insert.params[5]).toBe("error");
    expect(String(insert.params[6])).toContain("store unreachable");
  });

  it("answers isError for an unregistered tool", async () => {
    const { env, d1 } = makeEnv();
    const registry = createToolRegistry(env);
    const result = await registry.invoke("nope", {}, principal);
    expect(result.isError).toBe(true);
    // Nothing reached a handler, so nothing is audited.
    expect(d1.calls.filter((c) => c.sql.startsWith("INSERT"))).toHaveLength(0);
  });
});
