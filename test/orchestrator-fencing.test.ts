import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import { createRun, type DelegatedRun } from "../src/runs.js";
import { formatAgentResult } from "../src/opencode-input.js";
import { OpenCodeErrorEvent } from "../src/harness/opencode.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({ destroy: vi.fn(), execute: vi.fn(), grade: vi.fn(async () => null) }));
vi.mock("../src/result-quality.js", () => ({ evaluateResultQuality: mocks.grade }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
// Resolver seam, not vi.mock: detached continuations (an aborted child's
// finally) can bypass vi.mock's dynamic-import interception and load the
// real SDK.
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function agent() {
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { Sandbox: {}, GITHUB_TOKEN: "test-token" }, state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) { Object.assign(this, { state }); },
  });
  return instance;
}

function delegate(instance: CodingOrchestrator) {
  return instance.getTools()["delegate_coding_task"] as {
    execute: (input: unknown, options?: unknown) => Promise<unknown>;
  };
}

const INPUT = { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false };

beforeEach(() => { vi.resetAllMocks(); mocks.destroy.mockResolvedValue(undefined); });

describe("orchestrator generation fencing", () => {
  it("drops a late finish after cancelRun: run stays cancelled, no Slack post-back", async () => {
    const instance = agent();
    Object.assign(instance, {
      name: "slack:T1:C9:1700.0001",
      ctx: { waitUntil: vi.fn((p: Promise<unknown>) => p) },
    });
    Object.assign(instance.env, { SLACK_BOT_TOKEN: "xoxb-test" });
    const fetchMock = vi.fn(async (_url: unknown, _init?: { body?: unknown }) =>
      new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    let resolveChild: (value: string) => void = () => {};
    mocks.execute.mockImplementation(
      () => new Promise<string>((resolve) => { resolveChild = resolve; }),
    );
    try {
      const execution = delegate(instance).execute(INPUT, { toolCallId: "tc-cancel" }) as Promise<string>;
      await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
      await instance.cancelRun("agent-tool:tc-cancel");
      expect((instance.state.runs as DelegatedRun[])[0]?.status).toBe("cancelled");
      // Isolate the finish-time post from the "started"/"cancelled" posts already sent.
      fetchMock.mockClear();
      resolveChild(formatAgentResult({
        status: "completed", exitCode: 0, stderrTail: "",
        changedFiles: [], diff: "", files: [], summary: "late success",
      }));
      await execution;
      const run = (instance.state.runs as DelegatedRun[])[0]!;
      expect(run.status).toBe("cancelled");
      expect(run.summary).toBeUndefined();
      expect(
        fetchMock.mock.calls.filter((call) => String(call[0]).includes("chat.postMessage")),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never invokes the child when the run is already terminal (fenced running)", async () => {
    const instance = agent();
    const terminal = {
      ...createRun({
        runId: "agent-tool:tc-done", sandboxId: "s", repoUrl: INPUT.repoUrl,
        task: "t", baseBranch: "main", publishPullRequest: false,
      }),
      status: "completed" as const,
    };
    instance.setState({ runs: [terminal] });
    const out = await delegate(instance).execute(INPUT, { toolCallId: "tc-done" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(String(out)).toMatch(/completed/i);
    expect((instance.state.runs as DelegatedRun[])[0]?.status).toBe("completed");
  });

  it("stores a classified errorCode when the child fails with an HTTP status", async () => {
    const instance = agent();
    mocks.execute.mockRejectedValueOnce(new OpenCodeErrorEvent("provider returned status 429: rate limited"));
    const execution = delegate(instance).execute(INPUT, { toolCallId: "tc-429" });
    await expect(execution).rejects.toThrow(/status 429/);
    const run = (instance.state.runs as DelegatedRun[])[0]!;
    expect(run.status).toBe("error");
    expect(run.errorCode).toBe("rate_limit_exceeded");
  });

  it("classifies a structured failure envelope as executor_failed, not internal_error", async () => {
    const instance = agent();
    mocks.execute.mockResolvedValueOnce(formatAgentResult({
      status: "error", exitCode: 1, stderrTail: "",
      changedFiles: [], diff: "", files: [], summary: "harness crashed mid-task",
    }));
    const execution = delegate(instance).execute(INPUT, { toolCallId: "tc-envfail" }) as Promise<string>;
    await expect(execution).resolves.toBeDefined();
    const run = (instance.state.runs as DelegatedRun[])[0]!;
    expect(run.status).toBe("error");
    expect(run.errorCode).toBe("executor_failed");
  });

  it("does not evaluate quality on a dropped finish (stale grade on cancelled run)", async () => {
    const instance = agent();
    Object.assign(instance.env, { TYPESAFE_API_KEY: "ts-test" });
    let resolveChild: (value: string) => void = () => {};
    mocks.execute.mockImplementation(
      () => new Promise<string>((resolve) => { resolveChild = resolve; }),
    );
    const execution = delegate(instance).execute(INPUT, { toolCallId: "tc-grade" }) as Promise<string>;
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    await instance.cancelRun("agent-tool:tc-grade");
    resolveChild(formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "",
      changedFiles: [], diff: "", files: [], summary: "late success",
    }));
    await execution;
    // The eval call is synchronous inside the completed branch — after the
    // child resolves, it has either happened or never will.
    expect(mocks.grade).not.toHaveBeenCalled();
    const run = (instance.state.runs as DelegatedRun[])[0]!;
    expect(run.status).toBe("cancelled");
    expect(run.receipts?.some((r) => r.kind === "grade")).toBeFalsy();
  });
});
