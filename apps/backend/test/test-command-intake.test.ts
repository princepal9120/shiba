import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { parseAgentToolInput } from "../src/opencode-input.js";
import type { PendingApproval } from "../src/pending-approvals.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
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
    keepAliveWhile(fn: () => Promise<unknown>) {
      return mocks.keepAliveWhile(fn);
    }
    schedule(...args: unknown[]) {
      return mocks.schedule(...args);
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function env(overrides: Partial<Env> = {}): Env {
  return { ...productionEnvStubs(), Sandbox: {}, GITHUB_TOKEN: "test-token", ...overrides } as Env;
}

function agent(overrides: Partial<Env> = {}) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: env(overrides),
    state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) {
      setStateLikeProduction(this, state);
    },
  });
}

function queueRun(instance: CodingOrchestrator, input: Record<string, unknown> = {}) {
  return instance.onRequest(
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/o/r",
        task: "fix",
        ...input,
      }),
    }),
  );
}

function approveRun(instance: CodingOrchestrator, approvalId: string) {
  return instance.onRequest(
    new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
    }),
  );
}

async function dispatchedEnvelope() {
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
  const calls = mocks.execute.mock.calls as unknown as [[string]];
  return parseAgentToolInput([{ role: "user", text: calls[0]![0]! }]);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
});

describe("testCommand intake", () => {
  it("threads the queued test command through approval into the dispatched envelope", async () => {
    const instance = agent();
    mocks.execute.mockResolvedValue("ok");
    const testCommand = ["pnpm", "test"];
    const queued = await queueRun(instance, { testCommand });
    expect(queued.status).toBe(200);
    const { approvalId } = (await queued.json()) as { approvalId: string };
    const record = (instance.state.pendingApprovals ?? [])[0] as (PendingApproval & { testCommand?: string[] }) | undefined;
    expect(record?.testCommand).toEqual(testCommand);

    const approved = await approveRun(instance, approvalId);
    expect(approved.status).toBe(200);
    expect(instance.state.runs[0]).toMatchObject({ testCommand });
    expect(await dispatchedEnvelope()).toMatchObject({ testCommand });
  });

  it.each([
    ["nine arguments", Array.from({ length: 9 }, (_, index) => `arg-${index}`)],
    ["an empty argument", [""]],
    ["a shell string", "pnpm test"],
  ])("rejects testCommand with %s before creating an approval", async (_label, testCommand) => {
    const instance = agent();
    const response = await queueRun(instance, { testCommand });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "testCommand must be an argv array of 1-8 non-empty strings.",
    });
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it.each([
    ["omitted", {}],
    ["empty", { testCommand: [] }],
  ])("dispatches without testCommand when it is %s", async (_label, input) => {
    const instance = agent();
    mocks.execute.mockResolvedValue("ok");
    const queued = await queueRun(instance, input);
    expect(queued.status).toBe(200);
    const { approvalId } = (await queued.json()) as { approvalId: string };
    const record = (instance.state.pendingApprovals ?? [])[0] as (PendingApproval & { testCommand?: string[] }) | undefined;
    expect(record?.testCommand).toBeUndefined();

    const approved = await approveRun(instance, approvalId);
    expect(approved.status).toBe(200);
    expect(await dispatchedEnvelope()).not.toHaveProperty("testCommand");
  });
});
