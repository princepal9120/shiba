import { describe, expect, it, vi } from "vitest";

// Route every getAgentByName stub to one real CodingOrchestrator, recording the instance name.
const route = vi.hoisted(() => ({ names: [] as string[], fetch: (_r: Request): Promise<Response> => Promise.reject(new Error("unset")) }));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_ns: unknown, name: string) => {
    route.names.push(name);
    return { fetch: (request: Request) => route.fetch(request) };
  },
  routeAgentRequest: async () => null,
}));
vi.mock("agents/mcp", () => ({ McpAgent: class {} }));
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

import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import type { TokenRecord } from "../src/agent-tokens.js";
import type { Env } from "../src/env.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerEmailTools } from "../src/mcp-email-tools.js";
import { registerMemoryTools } from "../src/mcp-memory-tools.js";
import { registerRunTools } from "../src/mcp-run-tools.js";
import { createRun } from "../src/runs.js";

class FakeD1 {
  readonly rows: unknown[][] = [];
  prepare(_sql: string) {
    const rows = this.rows;
    return {
      run: async () => ({ success: true }),
      bind: (...params: unknown[]) => ({
        run: async () => {
          rows.push(params);
          return { success: true };
        },
      }),
    };
  }
}

const agent: TokenRecord = { principal: "claude-code", scopes: ["sandbox:exec"], created: 0, revoked: false };

function setup() {
  const orchestrator = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: {
      Sandbox: {},
      GITHUB_TOKEN: "test-token",
      // listApprovals kicks the stale-draft sweep; an empty directory keeps it quiet.
      Mailbox: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ mailboxes: [] }) }) },
    },
    state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) {
      Object.assign(this, { state });
    },
  });
  route.names.length = 0;
  route.fetch = (request) => orchestrator.onRequest(request);
  const d1 = new FakeD1();
  const env = { AGENT_AUDIT: d1, CodingOrchestrator: {} } as unknown as Env;
  const registry = createToolRegistry(env);
  registerRunTools(registry, env);
  // Audit row params: [id, ts, principal, tool, args_hash, outcome, detail].
  const outcomes = () => d1.rows.map((row) => `${row[3]}:${row[5]}`);
  return { orchestrator, registry, env, outcomes };
}

const data = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, unknown>;

describe("registerRunTools", () => {
  it("queue_run freezes the input as a pending approval on the default orchestrator", async () => {
    const { orchestrator, registry, outcomes } = setup();
    const result = await registry.invoke(
      "queue_run",
      {
        repoUrl: "https://github.com/o/r",
        task: "fix the flaky test",
        baseBranch: "dev",
        publishPullRequest: true,
        kind: "email_send", // must not reach the orchestrator
      },
      agent,
    );
    expect(result.isError).toBeUndefined();
    const { approvalId, runId, status } = data(result);
    expect(status).toBe("pending_approval");
    expect(runId).toBe(`agent-tool:${String(approvalId)}`);
    expect(orchestrator.state.pendingApprovals).toEqual([
      expect.objectContaining({
        approvalId,
        threadKey: "default",
        repoUrl: "https://github.com/o/r",
        task: "fix the flaky test",
        baseBranch: "dev",
        publishPullRequest: true,
        status: "pending",
      }),
    ]);
    expect(orchestrator.state.pendingApprovals?.[0]?.kind ?? "run").toBe("run");
    expect(route.names).toEqual(["default"]);

    const listed = await registry.invoke("list_approvals", {}, agent);
    expect((data(listed).approvals as Array<{ approvalId: string }>).map((a) => a.approvalId)).toEqual([approvalId]);
    expect(outcomes()).toEqual(["queue_run:ok", "list_approvals:ok"]);
  });

  it("refuses a token without sandbox:exec before reaching the orchestrator", async () => {
    const { orchestrator, registry, outcomes } = setup();
    const reader: TokenRecord = { ...agent, scopes: ["email:read", "memory:read"] };
    const result = await registry.invoke("queue_run", { repoUrl: "https://github.com/o/r", task: "t" }, reader);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('missing scope "sandbox:exec"');
    expect(route.names).toEqual([]);
    expect(orchestrator.state.pendingApprovals ?? []).toEqual([]);
    expect(outcomes()).toEqual(["queue_run:denied"]);
  });

  it("refuses an invalid repo via the orchestrator's own validation", async () => {
    const { orchestrator, registry, outcomes } = setup();
    for (const repoUrl of ["https://gitlab.com/o/r", "not a url", 42]) {
      const result = await registry.invoke("queue_run", { repoUrl, task: "t" }, agent);
      expect(result.isError).toBe(true);
    }
    expect(orchestrator.state.pendingApprovals ?? []).toEqual([]);
    expect(outcomes()).toEqual(["queue_run:error", "queue_run:error", "queue_run:error"]);
  });

  it("reads runs newest first and hides email approvals", async () => {
    const { orchestrator, registry } = setup();
    const run = (runId: string) =>
      createRun({ runId, sandboxId: `s-${runId}`, repoUrl: "https://github.com/o/r", task: "t", baseBranch: "main", publishPullRequest: false });
    orchestrator.setState({
      runs: [run("r1"), run("r2"), run("r3")],
      pendingApprovals: [
        { threadKey: "default", approvalId: "e1", repoUrl: "a@x.dev", task: "send", kind: "email_send", payload: { body_text: "secret" }, status: "pending", createdAt: Date.now() },
      ],
    });
    const listed = await registry.invoke("list_runs", { limit: 2 }, agent);
    expect((data(listed).runs as Array<{ runId: string }>).map((r) => r.runId)).toEqual(["r3", "r2"]);
    const one = await registry.invoke("run_status", { runId: "r2" }, agent);
    expect((data(one).run as { runId: string }).runId).toBe("r2");
    expect((await registry.invoke("run_status", { runId: "nope" }, agent)).isError).toBe(true);
    expect(data(await registry.invoke("list_approvals", {}, agent)).approvals).toEqual([]);
  });

  it("registers no approve tool anywhere on the gateway", () => {
    const { registry, env } = setup();
    registerEmailTools(registry, env);
    registerMemoryTools(registry, env);
    const names = registry.tools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["queue_run", "run_status", "list_runs", "list_approvals"]));
    expect(names.filter((n) => /approve|decide|resolve/i.test(n))).toEqual([]);
    expect(registry.tools().filter((t) => ["queue_run", "run_status", "list_runs", "list_approvals"].includes(t.name)).map((t) => t.scope)).toEqual(Array(4).fill("sandbox:exec"));
  });
});
