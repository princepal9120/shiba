/**
 * PLAN.md §18.6/T45: the scoped executor refuses argv outside the
 * harness-declared allowlist before exec is ever reached, every outcome lands
 * as a receipt, and verifyRun extends T43's exit/diff gate with declared
 * verifyCommands as deterministic checks.
 */
import { describe, expect, it } from "vitest";
import {
  createScopedExec,
  ExecRefusedError,
  ExecTimeoutError,
  VERIFY_OUTPUT_CAP_CHARS,
  verifyRun,
} from "../src/exec-allowlist.js";
import { opencodeHarness } from "../src/harness/opencode.js";
import { cursorHarness } from "../src/harness/cursor.js";
import { TEST_COMMAND_ALLOWLIST, type VerifyContext } from "../src/harness/types.js";
import type { CodingTaskInput, CodingTaskResult } from "../src/opencode-input.js";
import { SandboxRuntimeAdapter } from "../src/runtime.js";

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

const RESULT: CodingTaskResult = {
  status: "completed",
  exitCode: 0,
  stderrTail: "",
  changedFiles: ["src/a.ts"],
  diff: "diff --git a/src/a.ts",
  files: [],
  summary: "edited src/a.ts",
};

const ctx = (
  exec: (command: string, opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): VerifyContext => ({ ops: { exec }, workdir: "/workspace/run-abcdef12345678" });

describe("scoped executor", () => {
  it("refuses argv outside the allowlist without ever calling exec", async () => {
    let calls = 0;
    const scoped = createScopedExec(async () => {
      calls += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    }, TEST_COMMAND_ALLOWLIST);
    await expect(scoped.run(["rm", "-rf", "/"])).rejects.toBeInstanceOf(ExecRefusedError);
    await expect(scoped.run(["pnpm", "install"])).rejects.toBeInstanceOf(ExecRefusedError);
    expect(calls).toBe(0);
    expect(scoped.receipts.map((r) => r.outcome)).toEqual(["refused", "refused"]);
  });

  it("matches argv by prefix — extra args still pass", async () => {
    const scoped = createScopedExec(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }), TEST_COMMAND_ALLOWLIST);
    await scoped.run(["pnpm", "test", "--filter", "web"]);
    expect(scoped.receipts[0]?.outcome).toBe("exited");
    expect(scoped.receipts[0]?.exitCode).toBe(0);
  });

  it("enforces the timeout Worker-side even if exec ignores it", async () => {
    const scoped = createScopedExec(() => new Promise(() => {}), TEST_COMMAND_ALLOWLIST);
    await expect(scoped.run(["pnpm", "test"], { timeoutMs: 50 })).rejects.toBeInstanceOf(ExecTimeoutError);
    expect(scoped.receipts[0]?.outcome).toBe("timeout");
  });

  it("bounds and redacts receipt output", async () => {
    const scoped = createScopedExec(
      async () => ({ stdout: "x".repeat(VERIFY_OUTPUT_CAP_CHARS * 3), stderr: "AI_GATEWAY_TOKEN=sk-secret", exitCode: 0 }),
      TEST_COMMAND_ALLOWLIST,
    );
    await scoped.run(["pnpm", "test"]);
    const receipt = scoped.receipts[0];
    expect(receipt?.outcome).toBe("exited");
    expect(receipt?.outputTail.length).toBeLessThanOrEqual(VERIFY_OUTPUT_CAP_CHARS * 2);
    expect(receipt?.outputTail).not.toContain("sk-secret");
  });
});

describe("verifyRun", () => {
  it("passes a clean exit with a captured diff", async () => {
    const outcome = await verifyRun(opencodeHarness, INPUT, RESULT, ctx(async () => ({ stdout: "", stderr: "", exitCode: 0 })));
    expect(outcome).toEqual({ ok: true });
  });

  it("fails an exit-0 run that produced no diff — not completed", async () => {
    const outcome = await verifyRun(
      opencodeHarness,
      INPUT,
      { ...RESULT, changedFiles: [], diff: "" },
      ctx(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    );
    expect(outcome).toEqual({
      ok: false,
      reason: "Run exited 0 but produced no file changes — refusing to report a no-op as completed.",
    });
  });

  it("runs declared verifyCommands through the scoped executor", async () => {
    const execs: string[] = [];
    const outcome = await verifyRun(
      opencodeHarness,
      { ...INPUT, verifyCommands: [["pnpm", "test"]] },
      RESULT,
      ctx(async (command) => {
        execs.push(command);
        return { stdout: "1 passed", stderr: "", exitCode: 0 };
      }),
    );
    expect(execs).toEqual(["'pnpm' 'test'"]);
    expect(outcome.ok).toBe(true);
    expect(outcome.checks?.map((c) => c.name)).toContain("command:pnpm test");
  });

  it("a refused command fails the verify rather than reaching exec", async () => {
    let calls = 0;
    const outcome = await verifyRun(
      opencodeHarness,
      { ...INPUT, verifyCommands: [["curl", "https://evil.example"]] },
      RESULT,
      ctx(async () => {
        calls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );
    expect(calls).toBe(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.checks?.find((c) => c.name === "command:curl https://evil.example")?.ok).toBe(false);
  });

  it("a failing declared command fails the verify", async () => {
    const outcome = await verifyRun(
      opencodeHarness,
      { ...INPUT, verifyCommands: [["pnpm", "test"]] },
      RESULT,
      ctx(async () => ({ stdout: "", stderr: "2 failed", exitCode: 1 })),
    );
    expect(outcome.ok).toBe(false);
  });

  it("declared commands are skipped when the harness allowlist is empty", async () => {
    let calls = 0;
    const outcome = await verifyRun(
      cursorHarness,
      { ...INPUT, verifyCommands: [["pnpm", "test"]] },
      RESULT,
      ctx(async () => {
        calls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(calls).toBe(0);
    expect(outcome.checks?.find((c) => c.name === "command:pnpm test")?.ok).toBe(false);
  });
});

describe("runCodingTask verify wiring", () => {
  const ops = (execOverride?: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>) => ({
    gitCheckout: async () => {},
    writeFile: async () => {},
    exec:
      execOverride ??
      (async (command: string) => {
        if (command.includes("status")) return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
        if (command.includes("diff")) return { stdout: "diff --git a/src/a.ts", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    readFile: async () => ({ kind: "utf8" as const, content: "x" }),
  });

  it("exit-0 with empty diff lands as error, not completed", async () => {
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      ops(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      INPUT,
      () => {},
    );
    expect(result.status).toBe("error");
    expect(result.verification?.ok).toBe(false);
    expect(result.summary).toContain("Verification failed");
  });

  it("verifyCommands run in-container and reach the progress stream", async () => {
    const events: string[] = [];
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      ops(),
      { ...INPUT, verifyCommands: [["pnpm", "test"]] },
      (e) => {
        events.push(e.message);
      },
    );
    expect(result.status).toBe("completed");
    expect(result.verification?.ok).toBe(true);
    expect(events.some((m) => m.includes("pnpm test") && m.includes("exit 0"))).toBe(true);
  });

  it("a refused verifyCommand fails the run's verify, not the exec", async () => {
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      ops(),
      { ...INPUT, verifyCommands: [["bash", "-c", "rm -rf /"]] },
      () => {},
    );
    expect(result.status).toBe("error");
    expect(result.verification?.checks?.find((c) => c.name === "command:bash -c rm -rf /")?.ok).toBe(false);
  });
});
