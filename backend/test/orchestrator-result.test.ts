import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: vi.fn() }));
vi.mock("ai", () => ({ tool: vi.fn() }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import { formatAgentResult, parseAgentResult, type CodingTaskResult } from "../src/opencode-input.js";

function completedResult(): CodingTaskResult {
  return {
    status: "completed",
    exitCode: 0,
    stderrTail: "",
    changedFiles: ["a.ts"],
    diff: "diff --git a/a.ts",
    files: [{ path: "a.ts", content: "x", encoding: "utf8" as const }],
    summary: "done",
  };
}

function errorResult(): CodingTaskResult {
  return {
    status: "error",
    exitCode: 3,
    stderrTail: "boom",
    changedFiles: [],
    diff: "",
    files: [],
    summary: "quota exhausted",
  };
}

function makeOrchestrator(): any {
  const instance: any = Object.create(CodingOrchestrator.prototype);
  instance.state = { runs: [] };
  instance.env = {};
  instance.setState = (s: unknown) => {
    instance.state = s;
  };
  return instance;
}

const DELEGATE_INPUT = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
};

describe("T8 parseAgentResult", () => {
  it("parses a completed envelope as completed", () => {
    const parsed = parseAgentResult(formatAgentResult(completedResult()));
    expect(parsed?.status).toBe("completed");
  });

  it("parses an error envelope as error", () => {
    const parsed = parseAgentResult(formatAgentResult(errorResult()));
    expect(parsed?.status).toBe("error");
    expect(parsed?.summary).toContain("quota exhausted");
  });

  it("returns null for malformed or absent envelopes, never silent success", () => {
    expect(parseAgentResult("just prose, no envelope")).toBeNull();
    expect(parseAgentResult("SHIBA_AI_COWORKER_CODING_RESULT_JSON\n{not json")).toBeNull();
  });
});

describe("T8 orchestrator structured result", () => {
  it("marks an error envelope as error, not completed", async () => {
    const orchestrator = makeOrchestrator();
    const childExecute = async () => formatAgentResult(errorResult());
    await (orchestrator as unknown as {
      executeDelegatedTask: (input: unknown, child: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-error");
    expect(orchestrator.state.runs).toHaveLength(1);
    expect(orchestrator.state.runs[0]?.status).toBe("error");
  });

  it("marks a completed envelope as completed", async () => {
    const orchestrator = makeOrchestrator();
    const childExecute = async () => formatAgentResult(completedResult());
    await (orchestrator as unknown as {
      executeDelegatedTask: (input: unknown, child: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-ok");
    expect(orchestrator.state.runs).toHaveLength(1);
    expect(orchestrator.state.runs[0]?.status).toBe("completed");
  });

  it("marks malformed output as error, never silent success", async () => {
    const orchestrator = makeOrchestrator();
    const childExecute = async () => "plain prose with no envelope";
    await (orchestrator as unknown as {
      executeDelegatedTask: (input: unknown, child: unknown, id: string) => Promise<string>;
    }).executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-bad");
    expect(orchestrator.state.runs).toHaveLength(1);
    expect(orchestrator.state.runs[0]?.status).toBe("error");
  });
});
