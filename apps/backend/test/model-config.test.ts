/**
 * Coverage for the `/api/model-config` surface (T2): the meta-routes
 * proxy (combined GET shape, verbatim subpath forwarding), the
 * ModelConfig DO routes on a fake ctx.storage, the connection/policy
 * validators, and the worker-level auth gate in front of the route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  routeAgentRequest: async () => null,
}));
vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({
  createMcpHandler: () => ({
    fetch: async () => Response.json({ mcp: "served" }, { status: 200 }),
    notify: {},
  }),
}));
vi.mock("../src/email-approvals.js", () => ({
  queueEmailApproval: async () => ({
    delivery: { mode: "gmail", skipped: true },
    run: { runId: "r-unqueued" },
  }),
}));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { handleMeta } from "../src/meta-routes.js";
import { ModelConfig, modelConfigStub } from "../src/model-config-do.js";
import {
  compatibleHarnesses,
  CONNECTION_SERVICES,
  EMPTY_POLICY,
  modelOptionsForPurpose,
  PURPOSES,
  validateConnectionModel,
  type Connection,
} from "../src/model-connections.js";
import { HARNESSES } from "../src/harness/index.js";

// ── Proxy-route fakes ───────────────────────────────────────────────────

interface ProxyCall {
  method: string;
  url: string;
  body: unknown;
  header: string | null;
}

/** A ModelConfig stub that records calls and answers per pathname. */
function makeModelConfigEnv(answers: Record<string, unknown> = {}, status = 200) {
  const calls: ProxyCall[] = [];
  const stub = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        body: request.method === "GET" ? null : await request.json().catch(() => null),
        header: request.headers.get("x-agent-principal"),
      });
      return Response.json(answers[url.pathname] ?? { ok: url.pathname }, { status });
    },
  };
  const env = {
    ModelConfig: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  } as unknown as Env;
  return { env, calls };
}

describe("GET /api/model-config (handleMeta)", () => {
  it("returns the combined {connections, policy, purposes} shape", async () => {
    const connections = [{ id: "conn_1", service: "anthropic", status: "ready" }];
    const policy = { version: 3, models: { orchestrator: "@cf/x" }, updatedAt: 1 };
    const { env, calls } = makeModelConfigEnv({
      "/connections": { connections },
      "/policy": { policy },
    });
    const response = await handleMeta(new Request("https://app.test/api/model-config"), env);
    expect(response).not.toBeNull();
    expect((response as Response).status).toBe(200);
    const body = (await (response as Response).json()) as Record<string, unknown>;
    expect(body.connections).toEqual(connections);
    expect(body.policy).toEqual(policy);
    expect(body.purposes).toEqual(PURPOSES);
    // One fan-out per store route, both forwarded verbatim.
    expect(calls.map((c) => c.url).sort()).toEqual(["/connections", "/policy"]);
  });

  it("falls back to [] connections and EMPTY_POLICY when the store omits the keys", async () => {
    const { env } = makeModelConfigEnv({ "/connections": {}, "/policy": {} });
    const response = await handleMeta(new Request("https://app.test/api/model-config"), env);
    const body = (await (response as Response).json()) as Record<string, unknown>;
    expect(body.connections).toEqual([]);
    expect(body.policy).toEqual(EMPTY_POLICY);
  });

  it("rejects non-GET on the combined route", async () => {
    const { env } = makeModelConfigEnv();
    const response = await handleMeta(
      new Request("https://app.test/api/model-config", { method: "POST" }),
      env,
    );
    expect((response as Response).status).toBe(405);
  });

  it("proxies /api/model-config/* verbatim — method, path, search, body, principal header", async () => {
    const { env, calls } = makeModelConfigEnv();
    const payload = JSON.stringify({ service: "anthropic", displayName: "Team key" });
    const response = await handleMeta(
      new Request("https://app.test/api/model-config/connections?limit=10", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Agent-Principal": "runner" },
        body: payload,
      }),
      env,
    );
    expect((response as Response).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/connections?limit=10",
      body: { service: "anthropic", displayName: "Team key" },
      header: "runner",
    });
  });

  it("forwards DELETE on connection ids and surfaces the store's status", async () => {
    const { env, calls } = makeModelConfigEnv({ "/connections/conn_9": { error: "nope" } }, 404);
    const response = await handleMeta(
      new Request("https://app.test/api/model-config/connections/conn_9", { method: "DELETE" }),
      env,
    );
    expect((response as Response).status).toBe(404);
    expect(await (response as Response).json()).toEqual({ error: "nope" });
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "/connections/conn_9" });
  });
});

// ── ModelConfig DO ──────────────────────────────────────────────────────

function makeDo() {
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
    },
  };
  const instance = new ModelConfig(ctx as never, {} as never);
  const call = (path: string, init?: RequestInit) =>
    instance.fetch(new Request(`https://internal${path}`, init));
  const register = async (body: Record<string, unknown> = {}) =>
    (await (
      await call("/connections", {
        method: "POST",
        body: JSON.stringify({ service: "anthropic", displayName: "Team key", ...body }),
      })
    ).json()) as { connection?: Connection; error?: string };
  return { call, register };
}

describe("ModelConfig DO", () => {
  it("rejects connection registration without a listed service or displayName", async () => {
    const { call, register } = makeDo();
    for (const service of ["not-a-service", "ANTHROPIC", ""]) {
      const res = await call("/connections", {
        method: "POST",
        body: JSON.stringify({ service, displayName: "x" }),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(`one of ${CONNECTION_SERVICES.join(", ")}`);
    }
    for (const displayName of [123, "", "x".repeat(121)]) {
      expect((await register({ displayName: displayName as string })).error).toContain("displayName");
    }
    expect((await register({ credentialRef: "y".repeat(201) })).error).toContain("at most 200");
  });

  it("refuses a literal API key as credentialRef — references only", async () => {
    const { register } = makeDo();
    for (const ref of ["sk-ant-abc123", `ghp_${"x".repeat(30)}`, "xoxb-123-456-abc"]) {
      const res = await register({ credentialRef: ref });
      expect(res.error).toContain("never paste key material");
    }
  });

  it("registers a connection with a conn_* id and the service's auth mode", async () => {
    const { call, register } = makeDo();
    const { connection: conn } = (await register({ credentialRef: "vault://k" })) as {
      connection: Connection;
    };
    expect(conn.id).toMatch(/^conn_/);
    expect(conn.service).toBe("anthropic");
    expect(conn.authMode).toBe("gateway-byok");
    expect(conn.status).toBe("unconfigured");
    const list = (await (await call("/connections")).json()) as { connections: Connection[] };
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]?.displayName).toBe("Team key");
    expect(list.connections[0]?.credentialRef).toBe("vault://k");
  });

  it("maps service-catalog services to worker-service-secret auth", async () => {
    const { register } = makeDo();
    const devin = await register({ service: "devin", displayName: "devin" });
    expect(devin.connection?.authMode).toBe("worker-service-secret");
    const cursor = await register({ service: "cursor", displayName: "cursor" });
    expect(cursor.connection?.authMode).toBe("worker-service-secret");
  });

  it("patches status/displayName, clears and validates credentialRef, supports markChecked", async () => {
    const { call, register } = makeDo();
    const conn = (await register()).connection as { id: string };
    const missing = await call("/connections/conn_nope", { method: "PATCH", body: "{}" });
    expect(missing.status).toBe(404);
    const badStatus = await call(`/connections/${conn.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "halfway" }),
    });
    expect(badStatus.status).toBe(400);
    expect(await badStatus.text()).toContain("ready, invalid, disabled, unconfigured");
    const cleared = await call(`/connections/${conn.id}`, {
      method: "PATCH",
      body: JSON.stringify({ credentialRef: null, status: "disabled", displayName: "Renamed" }),
    });
    expect(cleared.status).toBe(200);
    const patched = ((await cleared.json()) as { connection: Connection }).connection;
    expect(patched.credentialRef).toBeNull();
    expect(patched.status).toBe("disabled");
    expect(patched.displayName).toBe("Renamed");
    const checked = await call(`/connections/${conn.id}`, {
      method: "PATCH",
      body: JSON.stringify({ markChecked: true }),
    });
    expect(
      ((await checked.json()) as { connection: Connection }).connection.lastCheckedAt,
    ).toBeGreaterThan(0);
    const secretRef = await call(`/connections/${conn.id}`, {
      method: "PATCH",
      body: JSON.stringify({ credentialRef: `sk-proj-${"y".repeat(20)}` }),
    });
    expect(secretRef.status).toBe(400);
    expect((await call(`/connections/${conn.id}`, { method: "POST" })).status).toBe(405);
  });

  it("disables on DELETE and 404s on unknown ids", async () => {
    const { call, register } = makeDo();
    const conn = (await register()).connection as { id: string };
    const res = await call(`/connections/${conn.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connection: Connection }).connection.status).toBe("disabled");
    expect((await call("/connections/conn_nope", { method: "DELETE" })).status).toBe(404);
  });

  it("validates policy writes and bumps the version", async () => {
    const { call } = makeDo();
    const initial = (await (await call("/policy")).json()) as { policy: typeof EMPTY_POLICY };
    expect(initial.policy).toEqual(EMPTY_POLICY);
    expect((await call("/policy", { method: "PUT", body: JSON.stringify({ models: "x" }) })).status).toBe(400);
    const badPurpose = await call("/policy", {
      method: "PUT",
      body: JSON.stringify({ models: { nope: "@cf/a" } }),
    });
    expect(badPurpose.status).toBe(400);
    expect(await badPurpose.text()).toContain("Unknown purpose");
    const coding = await call("/policy", {
      method: "PUT",
      body: JSON.stringify({ models: { coding: "anthropic/x" } }),
    });
    expect(await coding.text()).toContain("routed per run");
    const intent = await call("/policy", {
      method: "PUT",
      body: JSON.stringify({ models: { intent: "@cf/x" } }),
    });
    expect(await intent.text()).toContain("TypeSafe-only");
    const badModel = await call("/policy", {
      method: "PUT",
      body: JSON.stringify({ models: { orchestrator: "not a model" } }),
    });
    expect(badModel.status).toBe(400);
    const ok = await call("/policy", {
      method: "PUT",
      body: JSON.stringify({ models: { orchestrator: "@cf/meta/llama-3.1", automation_gate: null } }),
    });
    expect(ok.status).toBe(200);
    const policy = ((await ok.json()) as { policy: { version: number; models: Record<string, string> } }).policy;
    expect(policy.version).toBe(1);
    expect(policy.models).toEqual({ orchestrator: "@cf/meta/llama-3.1" });
    const second = await call("/policy", {
      method: "PUT",
      body: JSON.stringify({ models: { orchestrator: "@cf/meta/llama-3.2" } }),
    });
    expect(((await second.json()) as { policy: { version: number } }).policy.version).toBe(2);
  });

  it("404s on unknown paths", async () => {
    const { call } = makeDo();
    expect((await call("/nope")).status).toBe(404);
  });
});

// ── model-connections helpers ───────────────────────────────────────────

function conn(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    owner: "deployment",
    service: "anthropic",
    status: "ready",
    authMode: "gateway-byok",
    displayName: "t",
    credentialRef: null,
    createdAt: 0,
    updatedAt: 0,
    lastCheckedAt: null,
    ...overrides,
  };
}

const SANDBOX_HARNESSES = (provider: string) =>
  Object.values(HARNESSES)
    .filter((h) => h.supportedProviders.includes(provider) && h.capabilities().supportedRuntimes.includes("sandbox"))
    .map((h) => h.name);

describe("compatibleHarnesses + validateConnectionModel", () => {
  it("lists only registered sandbox-capable harnesses that declare the provider", () => {
    const result = compatibleHarnesses("anthropic");
    // Pinned to the harnesses' own declarations, not a hardcoded set.
    expect(result).toEqual(SANDBOX_HARNESSES("anthropic"));
    expect(result).toContain("claude-code");
    expect(result).toContain("opencode");
    // Harnesses that cannot run in the sandbox never appear.
    expect(result).not.toContain("antigravity");
    expect(result).not.toContain("cursor");
    expect(compatibleHarnesses("cursor")).toEqual([]);
  });

  it("rejects a disabled connection and a remote-executor service", () => {
    expect(validateConnectionModel(conn({ status: "disabled" }), "anthropic/x", "claude-code")).toBe(
      "This connection is disabled.",
    );
    // cursor is a remote-executor service: it sits in PROVIDER_HOSTS for
    // model-id validation, but no harness can run its models.
    expect(validateConnectionModel(conn({ service: "cursor" }), "cursor/auto", "cursor")).toBe(
      "The cursor harness cannot run cursor models (supported: none).",
    );
  });

  it("rejects malformed ids, wrong namespaces, and unrunnable harness pairs", () => {
    expect(validateConnectionModel(conn(), "no-namespace", "claude-code")).toContain(
      "provider/model form",
    );
    expect(validateConnectionModel(conn(), "openai/gpt-5", "claude-code")).toBe(
      'Model "openai/gpt-5" does not belong to the anthropic connection.',
    );
    // The devin provider exists, but opencode cannot run devin models.
    const unrunnable = validateConnectionModel(conn({ service: "devin" }), "devin/auto", "opencode");
    expect(unrunnable).toContain("The opencode harness cannot run devin models");
    expect(unrunnable).toContain("supported: devin");
    // A valid pair passes.
    expect(validateConnectionModel(conn(), "anthropic/claude-sonnet-4", "claude-code")).toBeNull();
  });
});

describe("modelOptionsForPurpose", () => {
  it("only serves the coding purpose and only sandbox-runnable connections", () => {
    const connections = [
      conn({ id: "conn_a", status: "ready" }),
      conn({ id: "conn_b", status: "unconfigured" }),
      conn({ id: "conn_c", status: "disabled" }),
      conn({ id: "conn_d", service: "cursor", authMode: "worker-service-secret" }),
    ];
    // modelsByService is keyed by service name — the disabled and the
    // remote-executor connections are filtered before models are read.
    const options = modelOptionsForPurpose(connections, "coding", {
      anthropic: ["anthropic/a", "anthropic/b"],
      cursor: ["cursor/d"],
    });
    expect(modelOptionsForPurpose(connections, "orchestrator", { anthropic: ["x"] })).toEqual([]);
    const a = options.find((o) => o.connectionId === "conn_a");
    const b = options.find((o) => o.connectionId === "conn_b");
    // Every service-keyed model is offered per connection on that service.
    expect(options.filter((o) => o.connectionId === "conn_a").map((o) => o.modelId)).toEqual([
      "anthropic/a",
      "anthropic/b",
    ]);
    expect(options.filter((o) => o.connectionId === "conn_b").map((o) => o.modelId)).toEqual([
      "anthropic/a",
      "anthropic/b",
    ]);
    expect(a?.availability).toBe("configured");
    expect(b?.availability).toBe("unverified");
    expect(options.some((o) => o.connectionId === "conn_c")).toBe(false);
    expect(options.some((o) => o.connectionId === "conn_d")).toBe(false);
    expect(a?.purposes).toEqual(["coding"]);
    expect(a?.compatibleHarnesses).toEqual(compatibleHarnesses("anthropic"));
  });
});

// ── Auth gate through the worker ────────────────────────────────────────

describe("/api/model-config auth gating", () => {
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

  it("401s a non-loopback request when no identity system is configured", async () => {
    const { env } = makeModelConfigEnv({ "/connections": { connections: [] }, "/policy": {} });
    const response = await worker.fetch(new Request("https://app.test/api/model-config"), env, ctx);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("access_not_configured");
  });

  it("401s without the Access email header and 200s with it when REQUIRE_ACCESS is set", async () => {
    const { env, calls } = makeModelConfigEnv({
      "/connections": { connections: [{ id: "conn_1" }] },
      "/policy": { policy: EMPTY_POLICY },
    });
    (env as unknown as Record<string, unknown>).REQUIRE_ACCESS = "1";
    const denied = await worker.fetch(new Request("https://app.test/api/model-config"), env, ctx);
    expect(denied.status).toBe(401);
    expect(calls).toHaveLength(0);
    const allowed = await worker.fetch(
      new Request("https://app.test/api/model-config", {
        headers: { "CF-Access-Authenticated-User-Email": "dev@example.com" },
      }),
      env,
      ctx,
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { purposes: unknown };
    expect(body.purposes).toEqual(PURPOSES);
  });
});

describe("modelConfigStub", () => {
  it("resolves the singleton 'default' namespace", () => {
    const names: string[] = [];
    const env = {
      ModelConfig: {
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
        get: () => ({ fetch: async () => new Response() }),
      },
    } as unknown as Env;
    modelConfigStub(env);
    expect(names).toEqual(["default"]);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
