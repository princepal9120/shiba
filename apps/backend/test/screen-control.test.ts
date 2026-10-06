/**
 * PLAN-V2-NEXT computer-use surface: screen_action argv validation,
 * the scoped exec trail, the DO route, and the MCP tool registrations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import type { RunSignal } from "@shiba/shared";
import {
  runScreenAction,
  ScreenActionError,
  screenActionArgv,
  ScopedExecRefusal,
} from "../src/screen-control.js";
import type { ExecResult, SandboxOps } from "../src/runtime.js";
import { createRun } from "../src/runs.js";
import {
  setSandboxHandleResolver,
  setSandboxOpsFactory,
} from "../src/sandbox/lifecycle.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

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

const AGENT_PRINCIPAL_HEADER = "X-Agent-Principal";

function fakeOps(exec: SandboxOps["exec"]): SandboxOps {
  return {
    exec,
    gitCheckout: async () => {},
    writeFile: async () => {},
    readFile: async () => ({ kind: "utf8" as const, content: "" }),
  };
}

const okExec = vi.fn(async (_cmd: string): Promise<ExecResult> => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
}));

function agent() {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: {} },
    name: "dashboard:test",
    ctx: { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) },
    state: { runs: [] } as OrchestratorState,
    setState(this: CodingOrchestrator, next: OrchestratorState) {
      setStateLikeProduction(this, next);
    },
  });
}

function seedRun(instance: CodingOrchestrator, status: "running" | "completed") {
  const run = {
    ...createRun({
      runId: "run-1",
      sandboxId: "sbx-1",
      repoUrl: "https://github.com/o/r",
      task: "t",
      baseBranch: "main",
      publishPullRequest: false,
    }),
    status,
  };
  instance.state.runs = [run];
  return run;
}

const screenPost = (
  runId: string,
  action: Record<string, unknown>,
  principal?: string,
) =>
  new Request(`https://internal/api/runs/${encodeURIComponent(runId)}/screen`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(principal ? { [AGENT_PRINCIPAL_HEADER]: principal } : {}),
    },
    body: JSON.stringify({ action }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue("ok");
  okExec.mockClear();
  okExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  setSandboxOpsFactory(() => fakeOps(okExec));
});

describe("screenActionArgv", () => {
  it("click emits move+click with validated coords and button", () => {
    expect(screenActionArgv({ type: "click", x: 10, y: 20 })).toEqual([
      ["xdotool", "mousemove", "10", "20"],
      ["xdotool", "click", "1"],
    ]);
    expect(screenActionArgv({ type: "click", x: 1, y: 2, button: "right" })[1]).toEqual([
      "xdotool", "click", "3",
    ]);
    expect(screenActionArgv({ type: "click", x: 1, y: 2, button: 2 })[1]![2]).toBe("2");
  });

  it("type keeps metacharacters literal as one argv element", () => {
    const argv = screenActionArgv({ type: "type", text: "a; rm -rf / && $(x)" });
    expect(argv).toHaveLength(1);
    expect(argv[0]![4]).toBe("a; rm -rf / && $(x)");
  });

  it("scroll maps to wheel-button clicks", () => {
    expect(screenActionArgv({ type: "scroll", dx: 0, dy: 240 })).toEqual([
      ["xdotool", "click", "--repeat", "2", "5"],
    ]);
    expect(screenActionArgv({ type: "scroll", dx: -240, dy: 0 })[0]![4]).toBe("6");
  });

  it("rejects malformed input before it becomes argv", () => {
    const bad: unknown[] = [
      { type: "click", x: -1, y: 0 },
      { type: "click", x: 1.5, y: 0 },
      { type: "click", x: 0, y: 200_000 },
      { type: "click", x: 0, y: 0, button: 4 },
      { type: "type", text: "" },
      { type: "scroll", dx: 0, dy: 0 },
      { type: "key", keys: "a; rm -rf /" },
      { type: "key", keys: "ctrl+s && x" },
      { type: "key", keys: "$(whoami)" },
    ];
    for (const action of bad) {
      expect(() => screenActionArgv(action as never)).toThrow(ScreenActionError);
    }
    expect(() => screenActionArgv({ type: "nope" } as never)).toThrow(ScreenActionError);
  });

  it("shot emits scrot + base64", () => {
    expect(screenActionArgv({ type: "shot" })).toEqual([
      ["scrot", "-o", "/tmp/shiba-screen.png"],
      ["base64", "-w0", "/tmp/shiba-screen.png"],
    ]);
  });
});

describe("runScreenAction", () => {
  it("drives argv in order and collects exec.invoked/exec.settled signals", async () => {
    const signals: RunSignal[] = [];
    const result = await runScreenAction(
      fakeOps(okExec),
      { type: "click", x: 3, y: 4 },
      signals,
    );
    expect(result).toEqual({ ok: true });
    // shellJoin single-quotes every token — the sandbox shell joins them.
    expect(okExec).toHaveBeenCalledTimes(2);
    expect(okExec.mock.calls[0]![0]).toBe("'xdotool' 'mousemove' '3' '4'");
    expect(okExec.mock.calls[1]![0]).toBe("'xdotool' 'click' '1'");
    expect(signals.map((s) => s.kind)).toEqual([
      "exec.invoked",
      "exec.settled",
      "exec.invoked",
      "exec.settled",
    ]);
  });

  it("returns the base64 payload on shot", async () => {
    const shotExec = vi.fn(async (cmd: string): Promise<ExecResult> =>
      cmd.includes("base64")
        ? { stdout: "aGVsbG8=", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 });
    const result = await runScreenAction(fakeOps(shotExec), { type: "shot" }, []);
    expect(result).toEqual({ ok: true, screenshotBase64: "aGVsbG8=" });
  });

  it("stops at the first nonzero exit", async () => {
    const failExec = vi.fn(async (): Promise<ExecResult> => ({
      stdout: "",
      stderr: "no display",
      exitCode: 1,
    }));
    const result = await runScreenAction(
      fakeOps(failExec),
      { type: "click", x: 1, y: 1 },
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("no display");
    expect(failExec).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/runs/<id>/screen", () => {
  it("404s unknown runs and hides other principals' runs", async () => {
    const instance = agent();
    expect((await instance.onRequest(screenPost("run-nope", { type: "click", x: 0, y: 0 }))).status).toBe(404);
    const run = seedRun(instance, "running");
    instance.state.runs = [{ ...run, queuedBy: "agent-alpha" }];
    expect(
      (await instance.onRequest(screenPost("run-1", { type: "click", x: 0, y: 0 }, "agent-beta"))).status,
    ).toBe(404);
  });

  it("409s when the run is not running — no screen to drive", async () => {
    const instance = agent();
    seedRun(instance, "completed");
    const res = await instance.onRequest(screenPost("run-1", { type: "click", x: 0, y: 0 }));
    expect(res.status).toBe(409);
    expect(okExec).not.toHaveBeenCalled();
  });

  it("400s a malformed action without touching the sandbox", async () => {
    const instance = agent();
    seedRun(instance, "running");
    const res = await instance.onRequest(screenPost("run-1", { type: "key", keys: "$(x)" }));
    expect(res.status).toBe(400);
    expect(okExec).not.toHaveBeenCalled();
  });

  it("drives the action, records signals on the run, emits run.progress", async () => {
    const instance = agent();
    seedRun(instance, "running");
    const res = await instance.onRequest(
      screenPost("run-1", { type: "type", text: "hello" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(okExec).toHaveBeenCalledTimes(1);
    expect(okExec.mock.calls[0]![0]).toContain("'xdotool' 'type'");
    expect(okExec.mock.calls[0]![0]).toContain("'hello'");

    const run = instance.state.runs.find((r) => r.runId === "run-1");
    expect(run?.signals?.map((s) => s.kind)).toEqual(["exec.invoked", "exec.settled"]);
    const progress = (instance.state.events ?? []).find(
      (e) => e.kind === "run.progress" && e.runId === "run-1",
    );
    expect(progress).toBeDefined();
    expect((progress!.payload as { summary: string }).summary).toContain("screen_type");
  });

  it("returns the screenshot payload for shot", async () => {
    okExec.mockImplementation(async (cmd: string): Promise<ExecResult> =>
      cmd.includes("base64")
        ? { stdout: "iVBORw0K", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 });
    const instance = agent();
    seedRun(instance, "running");
    const res = await instance.onRequest(screenPost("run-1", { type: "shot" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { screenshotBase64: string }).screenshotBase64).toBe("iVBORw0K");
  });

  it("405s non-POST", async () => {
    const instance = agent();
    seedRun(instance, "running");
    const res = await instance.onRequest(
      new Request("https://internal/api/runs/run-1/screen", { method: "GET" }),
    );
    expect(res.status).toBe(405);
  });
});

describe("screen_* MCP tools", () => {
  it("register under sandbox:exec like the other mutating tools", async () => {
    const { createToolRegistry } = await import("../src/mcp-gateway.js");
    const { registerScreenTools } = await import("../src/mcp-screen-tools.js");
    const env = { AGENT_AUDIT: undefined, CodingOrchestrator: {} } as never;
    const registry = createToolRegistry(env);
    registerScreenTools(registry, env);
    const tools = registry.tools();
    for (const name of ["screen_click", "screen_type", "screen_scroll", "screen_key", "screen_shot"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.scope).toBe("sandbox:exec");
    }
    // A token without the scope is refused before the orchestrator.
    const denied = await registry.invoke(
      "screen_key",
      { runId: "run-1", keys: "Return" },
      { principal: "a", scopes: ["runs:read"], created: 0, revoked: false },
    );
    expect(denied.isError).toBe(true);
  });
});
