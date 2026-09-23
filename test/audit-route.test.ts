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
vi.mock("@cloudflare/think", () => ({
  Think: class {
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return { fetch: async () => Response.json({ mcp: "served" }) };
    }
  },
}));
vi.mock("../src/email-approvals.js", () => ({
  queueEmailApproval: async () => ({ approval_id: "apv-test" }),
  emailApprovalBridgeReady: () => true,
}));

/**
 * Route-level harness for `GET /api/audit` and the scheduled 90-day prune
 * (megaplan T13). The only storage seam is `env.AGENT_AUDIT`, faked by an
 * in-memory D1 that records (sql, params) pairs and answers `.all()` with
 * canned rows — so tests see both the query the route emits and the wire
 * shape the dashboard receives.
 */
import worker from "../src/index.js";
import { AUDIT_RETENTION_MS } from "../src/audit.js";
import type { Env } from "../src/env.js";

interface D1Call {
  sql: string;
  params: unknown[];
}

class FakeD1 {
  readonly calls: D1Call[] = [];
  rows: Record<string, unknown>[] = [];
  fail = false;

  prepare(sql: string) {
    const calls = this.calls;
    const shouldFail = () => this.fail;
    const run = async (...params: unknown[]) => {
      if (shouldFail()) throw new Error("d1 unavailable");
      calls.push({ sql, params });
      return { success: true, results: [], meta: { changes: 3 } };
    };
    const all = async (...params: unknown[]) => {
      if (shouldFail()) throw new Error("d1 unavailable");
      calls.push({ sql, params });
      return { results: this.rows, success: true, meta: {} };
    };
    return {
      run: () => run(),
      bind: (...params: unknown[]) => ({
        run: () => run(...params),
        all: () => all(...params),
        first: async () => null,
      }),
    };
  }
}

const ROW_NEWER = {
  id: "aud-2",
  ts: 2_000,
  principal: "scout",
  tool: "search_emails",
  args_hash: "b".repeat(64),
  outcome: "ok",
  detail: null,
};
const ROW_OLDER = {
  id: "aud-1",
  ts: 1_000,
  principal: "writer",
  tool: "memory_bank",
  args_hash: "a".repeat(64),
  outcome: "denied",
  detail: "missing scope",
};

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

function makeEnv(opts: { audit?: FakeD1 | null; automationsCalls?: string[] } = {}) {
  const d1 = opts.audit === undefined ? new FakeD1() : opts.audit;
  const automationsCalls = opts.automationsCalls ?? [];
  const automations = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: Request | string) => {
        automationsCalls.push(input instanceof Request ? input.url : String(input));
        return Response.json({ ok: true });
      },
    }),
  };
  const env = {
    Automations: automations,
    ...(d1 !== null ? { AGENT_AUDIT: d1 } : {}),
  } as unknown as Env;
  return { env, d1, automationsCalls };
}

describe("GET /api/audit", () => {
  it("returns rows newest-first with ORDER BY ts DESC and a 200-row default cap", async () => {
    const { env, d1 } = makeEnv();
    d1!.rows = [ROW_NEWER, ROW_OLDER];
    const { ctx } = makeCtx();
    const response = await worker.fetch(new Request("https://worker/api/audit"), env, ctx);
    expect(response.status).toBe(200);
    const select = d1!.calls.find((c) => c.sql.startsWith("SELECT"));
    expect(select).toBeDefined();
    expect(select!.sql).toContain("FROM audit_log");
    expect(select!.sql).toContain("ORDER BY ts DESC");
    expect(select!.sql).not.toContain("WHERE principal");
    expect(select!.params).toEqual([200]);
    const body = (await response.json()) as { entries: Array<typeof ROW_NEWER> };
    expect(body.entries.map((e) => e.id)).toEqual(["aud-2", "aud-1"]);
    expect(body.entries[1]!.detail).toBe("missing scope");
  });

  it("applies ?principal= as a WHERE clause and honors ?limit=", async () => {
    const { env, d1 } = makeEnv();
    const { ctx } = makeCtx();
    const response = await worker.fetch(
      new Request("https://worker/api/audit?principal=scout&limit=25"),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    const select = d1!.calls.find((c) => c.sql.startsWith("SELECT"));
    expect(select!.sql).toContain("WHERE principal = ?");
    expect(select!.params).toEqual(["scout", 25]);
  });

  it("clamps ?limit= to 200 and falls back on invalid values", async () => {
    const { env, d1 } = makeEnv();
    const { ctx } = makeCtx();
    await worker.fetch(new Request("https://worker/api/audit?limit=999"), env, ctx);
    let select = d1!.calls.filter((c) => c.sql.startsWith("SELECT")).pop();
    expect(select!.params).toEqual([200]);
    for (const bad of ["0", "-5", "abc"]) {
      d1!.calls.length = 0;
      await worker.fetch(new Request(`https://worker/api/audit?limit=${bad}`), env, ctx);
      select = d1!.calls.filter((c) => c.sql.startsWith("SELECT")).pop();
      expect(select!.params).toEqual([200]);
    }
  });

  it("rejects non-GET methods with 405", async () => {
    const { env, d1 } = makeEnv();
    const { ctx } = makeCtx();
    const response = await worker.fetch(
      new Request("https://worker/api/audit", { method: "POST" }),
      env,
      ctx,
    );
    expect(response.status).toBe(405);
    expect(d1!.calls.some((c) => c.sql.startsWith("SELECT"))).toBe(false);
  });

  it("answers 401 without an Access identity when REQUIRE_ACCESS is set", async () => {
    const { env } = makeEnv();
    (env as { REQUIRE_ACCESS?: string }).REQUIRE_ACCESS = "1";
    const { ctx } = makeCtx();
    const denied = await worker.fetch(new Request("https://worker/api/audit"), env, ctx);
    expect(denied.status).toBe(401);
    const authed = await worker.fetch(
      new Request("https://worker/api/audit", {
        headers: { "CF-Access-Authenticated-User-Email": "user@example.com" },
      }),
      env,
      ctx,
    );
    expect(authed.status).toBe(200);
  });

  it("answers 503 while the D1 binding is absent or its queries fail", async () => {
    const missing = makeEnv({ audit: null });
    const { ctx } = makeCtx();
    const unbound = await worker.fetch(new Request("https://worker/api/audit"), missing.env, ctx);
    expect(unbound.status).toBe(503);

    const failing = makeEnv();
    failing.d1!.fail = true;
    const broken = await worker.fetch(new Request("https://worker/api/audit"), failing.env, ctx);
    expect(broken.status).toBe(503);
  });
});

describe("scheduled audit retention", () => {
  it("prunes audit_log rows older than 90 days and still ticks automations", async () => {
    const { env, d1, automationsCalls } = makeEnv();
    const { ctx, pending } = makeCtx();
    const before = Date.now();
    await worker.scheduled({} as ScheduledController, env, ctx);
    await Promise.all(pending);

    const del = d1!.calls.find((c) => c.sql.startsWith("DELETE FROM audit_log"));
    expect(del).toBeDefined();
    expect(del!.sql).toContain("ts < ?");
    const cutoff = Number(del!.params[0]);
    expect(cutoff).toBeLessThanOrEqual(before - AUDIT_RETENTION_MS + 5_000);
    expect(cutoff).toBeGreaterThan(Date.now() - AUDIT_RETENTION_MS - 60_000);
    expect(automationsCalls).toEqual(["https://internal/internal/tick"]);
  });

  it("skips the prune without a binding but keeps the automations tick", async () => {
    const { env, automationsCalls } = makeEnv({ audit: null });
    const { ctx, pending } = makeCtx();
    await worker.scheduled({} as ScheduledController, env, ctx);
    await Promise.all(pending);
    expect(automationsCalls).toEqual(["https://internal/internal/tick"]);
  });

  it("a D1 failure warns and never blocks the tick", async () => {
    const { env, d1, automationsCalls } = makeEnv();
    d1!.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, pending } = makeCtx();
    await worker.scheduled({} as ScheduledController, env, ctx);
    await Promise.all(pending);
    expect(automationsCalls).toEqual(["https://internal/internal/tick"]);
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("audit prune failed")),
    ).toBe(true);
    warn.mockRestore();
  });
});
