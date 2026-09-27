/**
 * T42 typed run signals: the runtime adapter emits ordered milestones,
 * the result envelope carries them across the DO boundary, and the
 * orchestrator persists them on the run row. A waiter reads the signal
 * it needs — never a clock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasRunSignal, runSignal, type RunSignal } from "@shiba/shared";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import {
  formatAgentResult,
  parseAgentResult,
  type CodingTaskInput,
} from "../src/opencode-input.js";
import {
  SandboxRuntimeAdapter,
  type ExecResult,
  type SandboxOps,
} from "../src/runtime.js";
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

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix the thing",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "sbx-signals",
  codingModel: "google/gemini-3.5-flash-lite",
};

function fakeOps(overrides: Partial<SandboxOps> = {}): SandboxOps {
  return {
    async gitCheckout() {},
    async writeFile() {},
    async exec(command): Promise<ExecResult> {
      if (command.includes("opencode")) return { stdout: "done", stderr: "", exitCode: 0 };
      if (command.includes("status")) return { stdout: " M a.ts\n", stderr: "", exitCode: 0 };
      if (command.includes("diff")) return { stdout: "diff --git a/a.ts", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return { kind: "utf8", content: "x" } as const;
    },
    ...overrides,
  };
}

const emit = async () => {};
// Milestone assertions compare lifecycle kinds only — T45 exec.* receipts
// interleave between milestones and are asserted separately in exec-allowlist.test.ts.
const kinds = (signals: RunSignal[]) => signals.map((s) => s.kind).filter((k) => !k.startsWith("exec."));

describe("run-signal producer", () => {
  it("emits the ordered pipeline milestones on a successful run", async () => {
    const signals: RunSignal[] = [];
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      fakeOps(), INPUT, emit, { signals },
    );
    expect(result.status).toBe("completed");
    // Caller's collector and the envelope see the same ordered record.
    expect(result.signals).toEqual(signals);
    expect(kinds(signals)).toEqual([
      "sandbox.ready",
      "clone.complete",
      "config.written",
      "harness.started",
      "harness.idle",
      "collect.complete",
    ]);
    for (const signal of signals) expect(signal.at).toBeGreaterThan(0);
    expect(runSignal(signals, "harness.idle")?.detail).toBe("exitCode:0");
  });

  it("a clone failure leaves only sandbox.ready — the missing signals name the lost phase", async () => {
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      fakeOps({ gitCheckout: async () => { throw new Error("network down"); } }),
      INPUT, emit, {},
    );
    expect(result.status).toBe("error");
    expect(kinds(result.signals ?? [])).toEqual(["sandbox.ready"]);
    expect(hasRunSignal(result.signals, "collect.complete")).toBe(false);
  });

  it("a nonzero harness exit records harness.idle with the exit code", async () => {
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      fakeOps({
        exec: async (command) =>
          command.includes("opencode")
            ? { stdout: "", stderr: "boom", exitCode: 3 }
            : { stdout: "", stderr: "", exitCode: 0 },
      }),
      INPUT, emit, {},
    );
    expect(result.status).toBe("error");
    expect(runSignal(result.signals, "harness.idle")?.detail).toBe("exitCode:3");
    expect(hasRunSignal(result.signals, "collect.complete")).toBe(false);
  });

  it("a collection failure carries every signal through harness.idle", async () => {
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      fakeOps({
        exec: async (command) => {
          if (command.includes("status")) throw new Error("git status failed");
          if (command.includes("opencode")) return { stdout: "", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      }),
      INPUT, emit, {},
    );
    expect(result.status).toBe("error");
    expect(kinds(result.signals ?? [])).toEqual([
      "sandbox.ready", "clone.complete", "config.written", "harness.started", "harness.idle",
    ]);
  });
});

describe("run-signal envelope", () => {
  it("round-trips signals through formatAgentResult/parseAgentResult", () => {
    const signals: RunSignal[] = [
      { kind: "sandbox.ready", at: 1, detail: "sbx-1" },
      { kind: "collect.complete", at: 2, detail: "3 files" },
    ];
    const parsed = parseAgentResult(formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["a.ts"],
      diff: "", files: [], summary: "ok", signals,
    }));
    expect(parsed?.signals).toEqual(signals);
  });
});

describe("run-signal waiter (orchestrator row)", () => {
  function agent() {
    return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
      env: { Sandbox: {}, GITHUB_TOKEN: "test-token" }, state: { runs: [] } as OrchestratorState,
      setState(state: OrchestratorState) { Object.assign(this, { state }); },
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.destroy.mockResolvedValue(undefined);
  });

  it("persists the child's signals on the run row — the waiter reads them, not a clock", async () => {
    const signals: RunSignal[] = [
      { kind: "sandbox.ready", at: 1 },
      { kind: "clone.complete", at: 2 },
      { kind: "harness.idle", at: 3 },
      { kind: "collect.complete", at: 4 },
    ];
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["a.ts"],
      diff: "", files: [], summary: "ok", signals,
    }));
    const instance = agent();
    approveDirect(instance, "sig1");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<string>;
    };
    await delegate.execute(
      { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "sig1" },
    );
    const run = instance.state.runs[0]!;
    expect(run.status).toBe("completed");
    expect(run.signals).toEqual(signals);
    expect(hasRunSignal(run.signals, "collect.complete")).toBe(true);
  });

  it("persists partial signals on a failed run", async () => {
    const signals: RunSignal[] = [
      { kind: "sandbox.ready", at: 1 },
      { kind: "clone.complete", at: 2 },
      { kind: "harness.started", at: 3 },
    ];
    mocks.execute.mockResolvedValue(formatAgentResult({
      status: "error", exitCode: 1, stderrTail: "", changedFiles: [],
      diff: "", files: [], summary: "harness blew up", signals,
    }));
    const instance = agent();
    approveDirect(instance, "sig2");
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<string>;
    };
    await delegate.execute(
      { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "sig2" },
    );
    const run = instance.state.runs[0]!;
    expect(run.status).toBe("error");
    expect(run.signals).toEqual(signals);
    expect(hasRunSignal(run.signals, "harness.idle")).toBe(false);
  });
});
