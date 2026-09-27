/**
 * T45 — scoped command execution (PLAN.md §18.6).
 *
 * Pins: allowlisted command executes and produces a receipt; off-list
 * command refused without reaching exec; timeout enforced; output cap
 * enforced; a run's receipts show the exec trail in order; a declared
 * testCommand feeds verify — refused or nonzero is not "completed".
 */
import { describe, expect, it } from "vitest";
import type { RunSignal } from "@shiba/shared";
import {
  ScopedExecRefusal,
  matchesPrefix,
  scopedExec,
  tokenizeCommand,
} from "../src/exec-allowlist.js";
import { SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const ALLOWLIST = [["git"], ["pnpm", "test"], ["opencode"]] as const;

function fakeOps(exec?: SandboxOps["exec"]): SandboxOps {
  return {
    async gitCheckout() {},
    async writeFile() {},
    exec: exec ?? (async () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
    async readFile() {
      return { kind: "utf8", content: "x" };
    },
  };
}

describe("tokenizeCommand", () => {
  it("tokenizes plain and shell-quoted argv", () => {
    expect(tokenizeCommand("pnpm test --filter x")).toEqual(["pnpm", "test", "--filter", "x"]);
    expect(tokenizeCommand("git add -N -- 'src/a b.ts'")).toEqual(["git", "add", "-N", "--", "src/a b.ts"]);
    expect(tokenizeCommand('opencode run "task one"')).toEqual(["opencode", "run", "task one"]);
  });

  it("refuses unparseable input instead of guessing", () => {
    expect(tokenizeCommand("echo 'unterminated")).toBeNull();
    expect(tokenizeCommand("   ")).toBeNull();
  });
});

describe("matchesPrefix", () => {
  it("matches literal argv prefixes only", () => {
    expect(matchesPrefix(["pnpm", "test", "--run"], ["pnpm", "test"])).toBe(true);
    expect(matchesPrefix(["pnpm", "exec", "rm"], ["pnpm", "test"])).toBe(false);
    expect(matchesPrefix(["git"], ["git", "status"])).toBe(false);
    // A quoted segment does not turn the prefix into a substring match.
    expect(matchesPrefix(["pnpm test", "x"], ["pnpm"])).toBe(false);
  });
});

describe("scopedExec", () => {
  it("executes an allowlisted command and produces the invoked+settled receipts", async () => {
    const signals: RunSignal[] = [];
    const result = await scopedExec(fakeOps(), "pnpm test --run", { allowlist: ALLOWLIST, signals });
    expect(result.exitCode).toBe(0);
    expect(signals.map((s) => s.kind)).toEqual(["exec.invoked", "exec.settled"]);
    expect(signals[1]!.detail).toContain('"exit":0');
    expect(signals[0]!.detail).toContain("pnpm test --run");
  });

  it("refuses an off-list command without ever reaching exec", async () => {
    let reached = false;
    const ops = fakeOps(async () => {
      reached = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const signals: RunSignal[] = [];
    await expect(scopedExec(ops, "rm -rf /", { allowlist: ALLOWLIST, signals })).rejects.toBeInstanceOf(
      ScopedExecRefusal,
    );
    expect(reached).toBe(false);
    expect(signals.map((s) => s.kind)).toEqual(["exec.invoked", "exec.settled"]);
    expect(signals[1]!.detail).toContain('"refused":true');
  });

  it("enforces the per-command timeout by forwarding it to exec", async () => {
    let seenTimeout: number | undefined;
    const ops = fakeOps(async (_c, opts) => {
      seenTimeout = opts?.timeoutMs;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await scopedExec(ops, "pnpm test", { allowlist: ALLOWLIST, timeoutMs: 1234 });
    expect(seenTimeout).toBe(1234);
  });

  it("enforces the output cap (tail kept) and marks the receipt truncated", async () => {
    const big = "x".repeat(20_000);
    const ops = fakeOps(async () => ({ stdout: big, stderr: big, exitCode: 0 }));
    const signals: RunSignal[] = [];
    const result = await scopedExec(ops, "pnpm test", { allowlist: ALLOWLIST, signals, maxOutputChars: 100 });
    // boundTail keeps the tail plus a truncation marker.
    expect(result.stdout.endsWith("x".repeat(100))).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(140);
    expect(result.stderr.endsWith("x".repeat(100))).toBe(true);
    expect(signals.find((s) => s.kind === "exec.settled")!.detail).toContain('"truncated":true');
  });

  it("receipts a thrown exec error, then rethrows", async () => {
    const ops = fakeOps(async () => {
      throw new Error("container lost");
    });
    const signals: RunSignal[] = [];
    await expect(scopedExec(ops, "pnpm test", { allowlist: ALLOWLIST, signals })).rejects.toThrow("container lost");
    expect(signals[1]!.detail).toContain('"thrown":true');
  });
});

describe("adapter integration", () => {
  const INPUT: CodingTaskInput = {
    repoUrl: "https://github.com/owner/repo",
    task: "fix it",
    baseBranch: "main",
    publishPullRequest: false,
    sandboxId: "run-abcdef12345678",
    codingModel: "google/gemini-3.5-flash-lite",
  };

  function runOps(testExit = 0): SandboxOps & { commands: string[] } {
    const commands: string[] = [];
    return {
      commands,
      async gitCheckout() {},
      async writeFile() {},
      async exec(command, opts) {
        commands.push(command);
        if (command.includes("'pnpm' 'test'")) {
          return { stdout: "tests", stderr: "", exitCode: testExit };
        }
        if (command.includes("status")) {
          return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
        }
        if (command.includes("diff")) {
          return { stdout: "diff --git a/src/a.ts", stderr: "", exitCode: 0 };
        }
        void opts;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return { kind: "utf8", content: "x" };
      },
    };
  }

  it("runs a declared allowlisted testCommand and reports completed", async () => {
    const ops = runOps(0);
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      ops,
      { ...INPUT, testCommand: ["pnpm", "test"] },
      () => {},
    );
    expect(result.status).toBe("completed");
    expect(ops.commands).toContain("'pnpm' 'test'");
    // The run's receipts show the exec trail in order.
    const execSettled = (result.signals ?? []).filter((s) => s.kind === "exec.settled");
    const testReceipt = execSettled.find((s) => s.detail?.includes("'pnpm' 'test'"));
    expect(testReceipt?.detail).toContain('"exit":0');
    const order = (result.signals ?? []).map((s) => s.kind);
    expect(order.indexOf("exec.invoked")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("collect.complete")).toBeLessThan(order.indexOf("exec.settled", order.indexOf("collect.complete")));
  });

  it("a refused testCommand fails the verify, not the exec — status error", async () => {
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      runOps(),
      { ...INPUT, testCommand: ["rm", "-rf"] },
      () => {},
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("no exec receipt");
    // …and the refusal was receipted, not silently dropped.
    const refused = (result.signals ?? []).find((s) => s.detail?.includes('"refused":true'));
    expect(refused).toBeDefined();
  });

  it("a nonzero testCommand exit fails verify — completed requires tests to pass", async () => {
    const result = await new SandboxRuntimeAdapter().runCodingTask(
      runOps(1),
      { ...INPUT, testCommand: ["pnpm", "test"] },
      () => {},
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("did not exit 0");
  });

  it("adapter-internal git + harness execs run through the same scoped boundary", async () => {
    const ops = runOps();
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("completed");
    const invoked = (result.signals ?? []).filter((s) => s.kind === "exec.invoked").map((s) => s.detail);
    // harness exec, git status, git add, git diff — all receipted.
    expect(invoked.some((d) => d?.includes("'opencode'"))).toBe(true);
    expect(invoked.filter((d) => d?.includes("git")).length).toBeGreaterThanOrEqual(2);
  });
});
