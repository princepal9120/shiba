/**
 * T72: the repo's `.shiba/setup.json` initialize runs only when the human
 * opted in, before the baseline checkpoint, and a failure fails the run.
 */
import { describe, expect, it, vi } from "vitest";
import { LOCAL_RUNTIME_FLAG, runInputHash } from "@shiba/shared";
import { CodingOrchestrator, delegateInputSchema } from "../src/agents/orchestrator.js";
import { opencodeHarness } from "../src/harness/opencode.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import { parseRepoSetup, SETUP_FILE } from "../src/repo-setup.js";
import { SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";
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

const MARKER = "echo shiba-setup-marker";
const SETUP_JSON = JSON.stringify({ format_version: 1, scripts: { initialize: MARKER }, timeouts: { initialize: 120 } });
const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo",
  task: "t",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abc",
  codingModel: "google/gemini-3.5-flash-lite",
};

describe("parseRepoSetup", () => {
  it("loads a Capy-shaped file whose refresh and entries aren't run yet", () => {
    const capy = { format_version: 1, scripts: { initialize: MARKER, refresh: "pnpm i" }, timeouts: { refresh: 60 }, entries: [] };
    expect(parseRepoSetup(JSON.stringify(capy))).toEqual({ initialize: MARKER, timeoutMs: 600_000 });
  });

  it("reads initialize and the timeout, defaulting to 10 minutes", () => {
    expect(parseRepoSetup(SETUP_JSON)).toEqual({ initialize: MARKER, timeoutMs: 120_000 });
    expect(parseRepoSetup(JSON.stringify({ format_version: 1 }))).toEqual({ timeoutMs: 600_000 });
  });

  it.each([
    ["not json", /valid JSON/],
    [JSON.stringify({ format_version: 2 }), /format_version/],
    [JSON.stringify({ format_version: 1, scripts: { initialize: " " } }), /initialize/],
    [JSON.stringify({ format_version: 1, timeouts: { initialize: 901 } }), /timeouts.initialize/],
    [JSON.stringify({ format_version: 1, scripts: "pnpm install" }), /scripts must be an object/],
    [JSON.stringify({ format_version: 1, scripts: { init: "pnpm install" } }), /unknown key "init"/],
    [JSON.stringify({ format_version: 1, timeouts: "slow" }), /timeouts must be an object/],
  ])("refuses %s", (text, error) => {
    expect(() => parseRepoSetup(text)).toThrow(error);
  });
});

describe("sandbox runtime", () => {
  function run(
    input: CodingTaskInput,
    opts: {
      file?: string;
      setupExit?: number;
      env?: Record<string, string>;
      setupPaths?: string;
      status?: string;
      tracked?: boolean;
      diffTreeExit?: number;
    } = {},
  ) {
    const calls: { command: string; cwd?: string; env?: Record<string, string> }[] = [];
    const signals: { kind: string; detail?: string }[] = [];
    const ops = {
      async gitCheckout() {},
      async writeFile() {},
      async exec(command: string, execOpts?: { cwd?: string; env?: Record<string, string> }) {
        calls.push({ command, cwd: execOpts?.cwd, env: execOpts?.env });
        if (command.includes(MARKER)) return { stdout: "", stderr: "boom", exitCode: opts.setupExit ?? 0 };
        if (command.includes("diff-tree")) return { stdout: opts.setupPaths ?? "", stderr: "", exitCode: opts.diffTreeExit ?? 0 };
        if (command.includes("rev-parse") && command.includes("HEAD")) return { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
        if (command.includes("ls-files")) return { stdout: "", stderr: "", exitCode: opts.tracked ? 0 : 1 };
        if (command.includes("status")) return { stdout: opts.status ?? "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile(path: string) {
        if (path.endsWith(SETUP_FILE)) {
          if (opts.file === undefined) throw new Error("ENOENT");
          return { kind: "utf8", content: opts.file };
        }
        return { kind: "utf8", content: "" };
      },
    } as unknown as SandboxOps;
    const result = new SandboxRuntimeAdapter(opencodeHarness).runCodingTask(ops, input, () => {}, {
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      signals: signals as never,
    });
    return { calls, signals, result };
  }

  it("sets setup's effects aside in a local-only commit, hooks and signing off", async () => {
    const { calls, result } = run({ ...INPUT, runSetup: true }, { file: SETUP_JSON });
    await result;
    const setupAt = calls.findIndex((c) => c.command.includes(MARKER));
    const commitAt = calls.findIndex((c) => c.command.includes("commit") && c.command.includes("--no-verify"));
    expect(commitAt).toBeGreaterThan(setupAt);
    expect(calls[commitAt]!.command).toContain("core.hooksPath=/dev/null");
    expect(calls[commitAt]!.command).toContain("commit.gpgsign=false");
  });

  it("checks overlap against the setup commit, failing closed when git can't answer", async () => {
    const { calls, result } = run({ ...INPUT, runSetup: true }, {
      file: SETUP_JSON,
      status: " M src/app.ts\n",
      diffTreeExit: 128,
    });
    const outcome = await result;
    expect(outcome.status).toBe("error");
    expect(outcome.summary).toContain("Repo setup check failed");
    const check = calls.find((c) => c.command.includes("diff-tree"));
    expect(check?.command).toContain("a".repeat(40));
    expect(check?.command).toContain("src/app.ts");
  });

  it("runs every set-aside git call with hooks and fsmonitor off", async () => {
    const { calls, result } = run({ ...INPUT, runSetup: true }, { file: SETUP_JSON });
    await result;
    const add = calls.find((c) => c.command.includes("'add'") || c.command.includes(" add "));
    expect(add?.command).toContain("core.hooksPath=/dev/null");
    expect(add?.command).toContain("core.fsmonitor=false");
  });

  it("fails the run when the agent changes a file setup also changed", async () => {
    const outcome = await run({ ...INPUT, runSetup: true }, {
      file: SETUP_JSON,
      setupPaths: "pnpm-lock.yaml\0",
      status: " M pnpm-lock.yaml\n",
    }).result;
    expect(outcome.status).toBe("error");
    expect(outcome.summary).toContain("repo setup also changed (pnpm-lock.yaml)");
  });

  it("names the setup step in receipts instead of persisting the script text", async () => {
    const { signals, result } = run({ ...INPUT, runSetup: true }, { file: SETUP_JSON });
    await result;
    const details = signals.map((s) => s.detail ?? "").join("\n");
    expect(details).toContain(".shiba/setup.json#initialize");
    expect(details).not.toContain(MARKER);
  });

  it("runs initialize before the baseline checkpoint and the harness, in the repo, with the approved env", async () => {
    const { calls, result } = run({ ...INPUT, runSetup: true }, { file: SETUP_JSON, env: { DATABASE_URL: "x" } });
    await result;
    const setupAt = calls.findIndex((c) => c.command.includes(MARKER));
    const firstGit = calls.findIndex((c) => c.command.includes("git"));
    const harnessAt = calls.findIndex((c) => c.command.includes("opencode"));
    expect(setupAt).toBeGreaterThanOrEqual(0);
    expect(setupAt).toBeLessThan(firstGit);
    expect(setupAt).toBeLessThan(harnessAt);
    expect(calls[setupAt]).toMatchObject({ cwd: "/workspace/run-abc", env: { DATABASE_URL: "x" } });
  });

  it("never runs repo shell without the opt-in, even when the file exists", async () => {
    const { calls, result } = run(INPUT, { file: SETUP_JSON });
    await result;
    expect(calls.some((c) => c.command.includes(MARKER))).toBe(false);
  });

  it("fails the run, without starting the harness, when initialize fails", async () => {
    const { calls, result } = run({ ...INPUT, runSetup: true }, { file: SETUP_JSON, setupExit: 2 });
    const outcome = await result;
    expect(outcome.status).toBe("error");
    expect(outcome.summary).toContain("initialize exited with code 2");
    expect(calls.some((c) => c.command.includes("opencode"))).toBe(false);
  });

  it("fails the run when setup was asked for but the repo has no setup file", async () => {
    const outcome = await run({ ...INPUT, runSetup: true }).result;
    expect(outcome.status).toBe("error");
    expect(outcome.summary).toContain(`no ${SETUP_FILE}`);
  });

  it("reports a tracked but unreadable setup file as a read error, not as missing", async () => {
    const outcome = await run({ ...INPUT, runSetup: true }, { tracked: true }).result;
    expect(outcome.status).toBe("error");
    expect(outcome.summary).toContain("could not be read");
  });
});

it("never lets the model's tool call opt a run into repo setup", () => {
  const parsed = delegateInputSchema.parse({ repoUrl: "https://github.com/o/r", task: "t", runSetup: true });
  expect(parsed).not.toHaveProperty("runSetup");
});

it("binds the opt-in into the approval hash", () => {
  const base = { repoUrl: "https://github.com/o/r", task: "t", baseBranch: "main", publishPullRequest: false };
  expect(runInputHash({ ...base, runSetup: true })).not.toBe(runInputHash(base));
});

describe("/api/runs intake", () => {
  function makeOrchestrator(env: Record<string, unknown> = {}) {
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
      env: { ...productionEnvStubs(), ...env },
      name: "default",
      state: { runs: [] },
      setState(next: unknown) {
        setStateLikeProduction(this as unknown as CodingOrchestrator, next as Parameters<CodingOrchestrator["setState"]>[0]);
      },
    });
    return instance as unknown as {
      onRequest: (request: Request) => Promise<Response>;
      state: { pendingApprovals?: { approvalId: string; runSetup?: boolean }[] };
    };
  }
  const queue = (body: Record<string, unknown>) =>
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix the tests", ...body }),
    });

  it("freezes the opt-in on the approval", async () => {
    const orchestrator = makeOrchestrator();
    const res = await orchestrator.onRequest(queue({ runSetup: true }));
    expect(res.status).toBe(200);
    const { approvalId } = (await res.json()) as { approvalId: string };
    expect(orchestrator.state.pendingApprovals?.find((a) => a.approvalId === approvalId)?.runSetup).toBe(true);
  });

  it("refuses a non-boolean opt-in instead of silently skipping setup", async () => {
    const res = await makeOrchestrator().onRequest(queue({ runSetup: "true" }));
    expect(res.status).toBe(400);
  });

  it("refuses setup when the run would use the local runtime", async () => {
    const res = await makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1", RUNTIME: "local" }).onRequest(queue({ runSetup: true }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("local runtime");
  });
});
