import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { describeRoleModels, resolveRoleModel } from "../src/agents/roles.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { parseAgentToolInput, formatAgentToolInput, type CodingTaskInput } from "../src/opencode-input.js";
import { approveDirect } from "./seeding.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile(fn: () => Promise<unknown>) { return mocks.keepAliveWhile(fn); }
  schedule(...args: unknown[]) { return mocks.schedule(...args); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function env(overrides: Partial<Env> = {}): Env {
  return { Sandbox: {}, GITHUB_TOKEN: "test-token", ...overrides } as Env;
}

function agent(overrides: Partial<Env> = {}) {
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: env(overrides), state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) { Object.assign(this, { state }); },
  });
  return instance;
}

const DELEGATE_INPUT = {
  repoUrl: "https://github.com/o/r",
  task: "fix",
  baseBranch: "main",
  publishPullRequest: false,
};

beforeEach(() => { vi.resetAllMocks(); mocks.destroy.mockResolvedValue(undefined); });

describe("resolveRoleModel", () => {
  it("returns null when no pin is configured, leaving the default chain", () => {
    expect(resolveRoleModel(env(), "fixer")).toBeNull();
  });

  it("resolves a ROLE_MODEL_MAP entry to harness + model", () => {
    const resolved = resolveRoleModel(
      env({ ROLE_MODEL_MAP: JSON.stringify({ fixer: { harness: "opencode", model: "opencode-go/deepseek-v3.2" } }) }),
      "fixer",
    );
    expect(resolved).toEqual({ harness: "opencode", model: "opencode-go/deepseek-v3.2" });
  });

  it("prefers the map over the per-role ROLE_MODEL__* var", () => {
    const resolved = resolveRoleModel(
      env({
        ROLE_MODEL_MAP: JSON.stringify({ fixer: { harness: "codex", model: "openai/gpt-5.3-codex" } }),
        ROLE_MODEL__FIXER: "opencode/opencode-go/deepseek-v3.2",
      }),
      "fixer",
    );
    expect(resolved).toEqual({ harness: "codex", model: "openai/gpt-5.3-codex" });
  });

  it("falls back to ROLE_MODEL__<ROLE> when the map has no entry for the role", () => {
    const resolved = resolveRoleModel(
      env({
        ROLE_MODEL_MAP: JSON.stringify({ reviewer: { harness: "codex" } }),
        ROLE_MODEL__FIXER: "opencode/opencode-go/deepseek-v3.2",
      }),
      "fixer",
    );
    expect(resolved).toEqual({ harness: "opencode", model: "opencode-go/deepseek-v3.2" });
  });

  it("a bare 'harness' pin inherits the harness's *_MODEL var, then the catalog default", () => {
    expect(resolveRoleModel(env({ ROLE_MODEL__FIXER: "codex", CODEX_MODEL: "openai/custom" }), "fixer"))
      .toEqual({ harness: "codex", model: "openai/custom" });
    expect(resolveRoleModel(env({ ROLE_MODEL__FIXER: "codex" }), "fixer"))
      .toEqual({ harness: "codex", model: "openai/gpt-5.3-codex" });
    expect(resolveRoleModel(env({ ROLE_MODEL_MAP: JSON.stringify({ designer: { harness: "devin" } }) }), "designer"))
      .toEqual({ harness: "devin", model: "devin/swe-2-medium" });
  });

  it("rejects a model whose provider has no known API host", () => {
    expect(() =>
      resolveRoleModel(env({ ROLE_MODEL__FIXER: "opencode/nosuchprovider/model" }), "fixer"),
    ).toThrow();
  });

  it("rejects a model the pinned harness does not support", () => {
    expect(() =>
      resolveRoleModel(env({ ROLE_MODEL__FIXER: "codex/anthropic/claude-sonnet-4-6" }), "fixer"),
    ).toThrow();
  });

  it("rejects a pin naming an unknown harness", () => {
    expect(() => resolveRoleModel(env({ ROLE_MODEL__FIXER: "not-a-harness" }), "fixer")).toThrow();
  });

  it("rejects a pin naming a gated harness the deployment has not enabled", () => {
    expect(() =>
      resolveRoleModel(env({ ROLE_MODEL__REVIEWER: "claude-subscription" }), "reviewer"),
    ).toThrow();
    expect(
      resolveRoleModel(
        env({ ROLE_MODEL__REVIEWER: "claude-subscription", SHIBA_CLAUDE_SUBSCRIPTION: "1" }),
        "reviewer",
      ),
    ).toEqual({ harness: "claude-subscription", model: "anthropic-subscription/claude-sonnet-4-6" });
  });

  it.each([
    ["not JSON", "{not json"],
    ["a bare array", "[]"],
    ["a non-role key", JSON.stringify({ wizard: { harness: "codex" } })],
    ["an entry without harness", JSON.stringify({ fixer: { model: "openai/gpt-5.3-codex" } })],
  ])("throws on malformed ROLE_MODEL_MAP: %s", (_label, raw) => {
    expect(() => resolveRoleModel(env({ ROLE_MODEL_MAP: raw }), "fixer")).toThrow();
  });
});

describe("describeRoleModels", () => {
  it("reports the deployment default for every role when nothing is pinned", () => {
    const rows = describeRoleModels(env());
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.source).toBe("default");
      expect(row.harness).toBe("opencode");
      expect(row.model).toBe("google/gemini-3.5-flash-lite");
      expect(row.error).toBeUndefined();
    }
  });

  it("labels each pin's source and surfaces broken pins as errors", () => {
    const rows = describeRoleModels(
      env({
        ROLE_MODEL_MAP: JSON.stringify({ fixer: { harness: "codex", model: "openai/gpt-5.3-codex" } }),
        ROLE_MODEL__REVIEWER: "devin/devin/swe-2-medium",
        ROLE_MODEL__DESIGNER: "nosuch-harness",
      }),
    );
    const byRole = Object.fromEntries(rows.map((row) => [row.role, row]));
    expect(byRole.fixer).toMatchObject({ source: "role-map", harness: "codex", model: "openai/gpt-5.3-codex" });
    expect(byRole.reviewer).toMatchObject({ source: "role-env", harness: "devin", model: "devin/swe-2-medium" });
    expect(byRole.orchestrator?.source).toBe("default");
    expect(byRole.explorer?.source).toBe("default");
    expect(byRole.designer?.error).toBeDefined();
  });
});

describe("role routing in delegation", () => {
  it("a pinned role overrides per-call harness and codingModel on the envelope", async () => {
    const instance = agent({
      ROLE_MODEL_MAP: JSON.stringify({ fixer: { harness: "codex", model: "openai/gpt-5.3-codex" } }),
    });
    mocks.execute.mockResolvedValue("ok");
    approveDirect(instance, "role1");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const execution = delegate.execute(
      { ...DELEGATE_INPUT, role: "fixer", harness: "opencode", codingModel: "xai/grok-4.6" },
      { toolCallId: "role1" },
    );
    execution.catch(() => {});
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    const calls = mocks.execute.mock.calls as unknown as [[string]];
    expect(parseAgentToolInput([{ role: "user", text: calls[0]![0]! }])).toMatchObject({
      role: "fixer",
      harness: "codex",
      codingModel: "openai/gpt-5.3-codex",
    });
    await execution.catch(() => {});
  });

  it("an unpinned role keeps the deployment default chain", async () => {
    const instance = agent({ CLAUDE_CODE_MODEL: "anthropic/claude-custom" });
    mocks.execute.mockResolvedValue("ok");
    approveDirect(instance, "role2");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const execution = delegate.execute(
      { ...DELEGATE_INPUT, role: "explorer", harness: "claude-code" },
      { toolCallId: "role2" },
    );
    execution.catch(() => {});
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    const calls = mocks.execute.mock.calls as unknown as [[string]];
    expect(parseAgentToolInput([{ role: "user", text: calls[0]![0]! }])).toMatchObject({
      role: "explorer",
      harness: "claude-code",
      codingModel: "anthropic/claude-custom",
    });
    await execution.catch(() => {});
  });

  it("threads the queued role through the approval record into the dispatched envelope", async () => {
    const instance = agent({ ROLE_MODEL__FIXER: "opencode/opencode-go/deepseek-v3.2" });
    mocks.execute.mockResolvedValue("ok");
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix", role: "fixer" }),
    }));
    expect(queued.status).toBe(200);
    const { approvalId } = (await queued.json()) as { approvalId: string };
    const record = (instance.state.pendingApprovals ?? [])[0]!;
    expect(record.role).toBe("fixer");
    const approved = await instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
    }));
    expect(approved.status).toBe(200);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    const calls = mocks.execute.mock.calls as unknown as [[string]];
    expect(parseAgentToolInput([{ role: "user", text: calls[0]![0]! }])).toMatchObject({
      role: "fixer",
      harness: "opencode",
      codingModel: "opencode-go/deepseek-v3.2",
    });
  });

  it("rejects a queue request naming an unknown role before any approval exists", async () => {
    const instance = agent();
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix", role: "wizard" }),
    }));
    expect(queued.status).toBe(400);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("a broken pin fails the queue request before the approval card", async () => {
    const instance = agent({ ROLE_MODEL__FIXER: "opencode/nosuchprovider/model" });
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix", role: "fixer" }),
    }));
    expect(queued.status).toBe(400);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });
});

describe("coding-task envelope", () => {
  it("round-trips role through format/parse and rejects unknown roles", () => {
    const input: CodingTaskInput = {
      repoUrl: "https://github.com/o/r",
      task: "fix",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "sbx-1",
      codingModel: "google/gemini-3.5-flash-lite",
      role: "reviewer",
    };
    const parsed = parseAgentToolInput([{ role: "user", text: formatAgentToolInput(input) }]);
    expect(parsed.role).toBe("reviewer");
    expect(() =>
      formatAgentToolInput({ ...input, role: "wizard" } as unknown as CodingTaskInput),
    ).toThrow();
  });
});
