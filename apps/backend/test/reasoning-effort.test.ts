/**
 * T67: per-run reasoning effort rides the frozen route — hashed with the
 * approval, and refused before any card exists when the harness can't honor it.
 */
import { describe, expect, it, vi } from "vitest";
import { describeRoute, isApprovedRoute, runInputHash, type ApprovedRoute, type ReasoningEffort } from "@shiba/shared";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { claudeCodeHarness } from "../src/harness/claude-code.js";
import { codexHarness } from "../src/harness/codex.js";
import { opencodeHarness } from "../src/harness/opencode.js";
import { EMPTY_POLICY } from "../src/model-connections.js";
import { resolveCodingRoute, type ModelConfigSnapshot } from "../src/model-policy.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({ getAgentByName: vi.fn(), routeAgentRequest: async () => null }));
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
  createMcpHandler: () => ({ fetch: async () => Response.json({ mcp: "served" }), notify: {} }),
}));

const SNAPSHOT: ModelConfigSnapshot = { connections: [], policy: EMPTY_POLICY, connectionOrder: [] };
const ROUTE: ApprovedRoute = {
  purpose: "coding",
  connectionId: null,
  modelId: "anthropic/claude-opus-5",
  harness: "claude-code",
  policyVersion: 0,
};

describe("route contract", () => {
  it("accepts a known effort and rejects anything else", () => {
    expect(isApprovedRoute({ ...ROUTE, reasoningEffort: "high" })).toBe(true);
    expect(isApprovedRoute({ ...ROUTE, reasoningEffort: "turbo" })).toBe(false);
  });

  it("shows the effort on the approval card", () => {
    expect(describeRoute({ ...ROUTE, reasoningEffort: "high" })).toBe(
      "claude-code · anthropic/claude-opus-5 · effort high · via deployment default",
    );
    expect(describeRoute(ROUTE)).toBe("claude-code · anthropic/claude-opus-5 · via deployment default");
  });

  it("binds the effort into the approval hash", () => {
    const base = { repoUrl: "https://github.com/o/r", task: "t", baseBranch: "main", publishPullRequest: false };
    expect(runInputHash({ ...base, route: { ...ROUTE, reasoningEffort: "low" } })).not.toBe(
      runInputHash({ ...base, route: { ...ROUTE, reasoningEffort: "high" } }),
    );
  });
});

describe("resolveCodingRoute", () => {
  it("freezes a supported effort on the route", () => {
    const route = resolveCodingRoute(SNAPSHOT, { model: "openai/gpt-5", harness: "codex", reasoningEffort: "xhigh" });
    expect(route.reasoningEffort).toBe("xhigh");
  });

  it("leaves the field off when no effort is asked for", () => {
    expect(resolveCodingRoute(SNAPSHOT, { model: "openai/gpt-5", harness: "codex" })).not.toHaveProperty(
      "reasoningEffort",
    );
  });

  it.each([
    ["devin", "devin/swe-2", "high"],
    ["claude-code", "anthropic/claude-opus-5", "minimal"],
    ["codex", "openai/gpt-5", "max"],
    ["opencode", "openai/gpt-5", "xhigh"],
  ] as const)("refuses %s with %s at %s", (harness, model, effort) => {
    expect(() => resolveCodingRoute(SNAPSHOT, { model, harness, reasoningEffort: effort })).toThrow(
      /does not support reasoning effort/,
    );
  });
});

describe("harness argv", () => {
  const withEffort = (harness: string, codingModel: string, reasoningEffort: ReasoningEffort): CodingTaskInput => ({
    repoUrl: "https://github.com/owner/repo",
    task: "Fix it.",
    baseBranch: "main",
    publishPullRequest: false,
    sandboxId: "run-abcdef12345678",
    codingModel,
    route: { purpose: "coding", connectionId: null, modelId: codingModel, harness, policyVersion: 0, reasoningEffort },
  });

  it("claude-code passes --effort", () => {
    expect(claudeCodeHarness.buildArgv(withEffort("claude-code", "anthropic/claude-opus-5", "max"), "/w")).toEqual([
      "claude", "--print", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "acceptEdits",
      "--model", "claude-opus-5", "--effort", "max", "--add-dir", "/w", "Fix it.",
    ]);
  });

  it("codex sets model_reasoning_effort as a TOML string", () => {
    expect(codexHarness.buildArgv(withEffort("codex", "openai/gpt-5", "high"), "/w")).toEqual([
      "codex", "exec", "--json", "--model", "gpt-5", "-c", 'model_reasoning_effort="high"', "--cd", "/w", "Fix it.",
    ]);
  });

  it("opencode passes --variant", () => {
    expect(opencodeHarness.buildArgv(withEffort("opencode", "openai/gpt-5", "medium"), "/w")).toEqual([
      "opencode", "run", "--format", "json", "--model", "openai/gpt-5", "--variant", "medium", "--dir", "/w", "Fix it.",
    ]);
  });
});

describe("/api/runs intake", () => {
  function makeOrchestrator() {
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
      env: productionEnvStubs(),
      name: "default",
      state: { runs: [] },
      setState(next: unknown) {
        setStateLikeProduction(this as unknown as CodingOrchestrator, next as Parameters<CodingOrchestrator["setState"]>[0]);
      },
    });
    return instance as unknown as {
      onRequest: (request: Request) => Promise<Response>;
      state: { pendingApprovals?: { approvalId: string; route?: ApprovedRoute }[] };
    };
  }
  const queue = (body: Record<string, unknown>) =>
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix the tests", ...body }),
    });

  it("rejects an unknown effort", async () => {
    const res = await makeOrchestrator().onRequest(queue({ reasoningEffort: "turbo" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Unknown reasoning effort");
  });

  it("refuses an effort the harness can't honor before minting a card", async () => {
    const orchestrator = makeOrchestrator();
    const res = await orchestrator.onRequest(queue({ harness: "opencode", reasoningEffort: "max" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not support reasoning effort");
    expect(orchestrator.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("freezes the effort on the minted approval's route", async () => {
    const orchestrator = makeOrchestrator();
    const res = await orchestrator.onRequest(queue({ harness: "opencode", reasoningEffort: "high" }));
    expect(res.status).toBe(200);
    const { approvalId } = (await res.json()) as { approvalId: string };
    const approval = orchestrator.state.pendingApprovals?.find((a) => a.approvalId === approvalId);
    expect(approval?.route?.reasoningEffort).toBe("high");
  });
});
