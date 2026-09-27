/**
 * T44 — git checkpointing via hidden refs (PLAN.md §18.5).
 *
 * Pins: capture writes a temp-index commit to refs/shiba/checkpoints/<id>/<seq>
 * without touching HEAD; baseline→settle diff is the turn diff verbatim;
 * oversize diff exports via the Worker hook and the receipt carries the key;
 * restore refuses on a no-rollback harness before touching the filesystem;
 * crafted ref names are rejected; prune drops stale refs oldest-first.
 */
import { describe, expect, it } from "vitest";
import type { RunSignal } from "@shiba/shared";
import {
  CheckpointRollbackRefusal,
  captureCheckpoint,
  checkpointRef,
  diffCheckpoints,
  isCheckpointRef,
  pruneCheckpoints,
  restoreCheckpoint,
} from "../src/git-checkpoint.js";
import { opencodeHarness } from "../src/harness/opencode.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import { SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";

/** A fake git: canned answers per argv shape, commands recorded. */
function gitOps(overrides: {
  diffOut?: string;
  refs?: string[];
} = {}): SandboxOps & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async gitCheckout() {},
    async writeFile() {},
    async exec(command, opts) {
      commands.push(command);
      const has = (s: string) => command.includes(s);
      if (has("rev-parse")) return { stdout: ".git\n", stderr: "", exitCode: 0 };
      if (has("write-tree")) return { stdout: "tree0id\n", stderr: "", exitCode: 0 };
      if (has("commit-tree")) return { stdout: "commit0id\n", stderr: "", exitCode: 0 };
      if (has("for-each-ref")) {
        return { stdout: (overrides.refs ?? []).join("\n") + "\n", stderr: "", exitCode: 0 };
      }
      if (has("'diff'")) return { stdout: overrides.diffOut ?? "diff --git a/x\n+x\n", stderr: "", exitCode: 0 };
      if (has("status")) return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
      void opts;
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return { kind: "utf8", content: "x" };
    },
  };
}

describe("checkpointRef / isCheckpointRef", () => {
  it("derives refs/shiba/checkpoints/<runId>/<seq> and validates the shape", () => {
    expect(checkpointRef("run-abc123", 0)).toBe("refs/shiba/checkpoints/run-abc123/0");
    expect(isCheckpointRef("refs/shiba/checkpoints/run-abc123/0")).toBe(true);
  });

  it("rejects crafted ref names", () => {
    expect(isCheckpointRef("refs/shiba/checkpoints/../main")).toBe(false);
    expect(isCheckpointRef("refs/heads/main")).toBe(false);
    expect(isCheckpointRef("refs/shiba/checkpoints/run id/0")).toBe(false);
    expect(isCheckpointRef("refs/shiba/checkpoints/a/0.lock")).toBe(false);
    expect(() => checkpointRef("run/../x", 0)).toThrow("Invalid checkpoint coordinates");
    expect(() => checkpointRef("run-x", 0.5)).toThrow();
  });
});

describe("captureCheckpoint", () => {
  it("commits the worktree via a temp index and points the hidden ref at it", async () => {
    const ops = gitOps();
    const commit = await captureCheckpoint(ops, "/repo", "run-abc123", 0);
    expect(commit).toBe("commit0id");
    const flat = ops.commands.join("\n");
    // Temp index stays inside .git, never in the worktree.
    expect(flat).toContain("read-tree");
    expect(flat).toContain("'add' '-A'");
    expect(flat).toContain("update-ref");
    expect(ops.commands.at(-1)).toBe("'git' 'update-ref' 'refs/shiba/checkpoints/run-abc123/0' 'commit0id'");
  });
});

describe("restoreCheckpoint", () => {
  it("refuses on a no-rollback harness before touching the filesystem", async () => {
    const ops = gitOps();
    await expect(
      restoreCheckpoint(ops, "/repo", checkpointRef("run-abc123", 0), opencodeHarness),
    ).rejects.toBeInstanceOf(CheckpointRollbackRefusal);
    // Refusal happened before any git command ran.
    expect(ops.commands).toEqual([]);
  });

  it("rejects a crafted ref without exec", async () => {
    const ops = gitOps();
    await expect(
      restoreCheckpoint(ops, "/repo", "refs/heads/main", opencodeHarness),
    ).rejects.toThrow("Refused crafted ref name");
    expect(ops.commands).toEqual([]);
  });
});

describe("diffCheckpoints", () => {
  it("diffs two validated refs", async () => {
    const ops = gitOps({ diffOut: "diff --git a/x\n+x\n" });
    const diff = await diffCheckpoints(ops, "/repo", checkpointRef("r", 0), checkpointRef("r", 1));
    expect(diff).toBe("diff --git a/x\n+x\n");
    await expect(diffCheckpoints(ops, "/repo", "HEAD", checkpointRef("r", 1))).rejects.toThrow("Refused crafted ref name");
  });
});

describe("pruneCheckpoints", () => {
  it("deletes all but the newest keepLast refs, oldest first", async () => {
    const ops = gitOps({
      refs: [
        "refs/shiba/checkpoints/run-a/0",
        "refs/shiba/checkpoints/run-a/1",
        "refs/shiba/checkpoints/run-a/2",
        "refs/shiba/checkpoints/run-a/3",
      ],
    });
    await pruneCheckpoints(ops, "/repo", "run-a", 2);
    const deleted = ops.commands.filter((c) => c.includes("'-d'"));
    expect(deleted).toEqual([
      "'git' 'update-ref' '-d' 'refs/shiba/checkpoints/run-a/0'",
      "'git' 'update-ref' '-d' 'refs/shiba/checkpoints/run-a/1'",
    ]);
  });

  it("ignores foreign refs under the prefix", async () => {
    const ops = gitOps({ refs: ["refs/shiba/checkpoints/run-a/0", "refs/shiba/checkpoints/evil/../x"] });
    await pruneCheckpoints(ops, "/repo", "run-a", 0);
    const deleted = ops.commands.filter((c) => c.includes("'-d'"));
    expect(deleted).toEqual(["'git' 'update-ref' '-d' 'refs/shiba/checkpoints/run-a/0'"]);
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

  it("captures baseline + settle and the turn diff is the checkpoint diff verbatim", async () => {
    const ops = gitOps({ diffOut: "diff --git a/src/a.ts b/src/a.ts\n+changed\n" });
    const signals: RunSignal[] = [];
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {}, { signals });
    expect(result.status).toBe("completed");
    // The diff on the result is the commit-to-commit checkpoint diff, verbatim.
    expect(result.diff).toBe("diff --git a/src/a.ts b/src/a.ts\n+changed\n");
    const captured = signals.filter((s) => s.kind === "checkpoint.captured").map((s) => s.detail);
    expect(captured).toEqual([
      "refs/shiba/checkpoints/run-abcdef12345678/0",
      "refs/shiba/checkpoints/run-abcdef12345678/1",
    ]);
    // Baseline lands before the harness starts; settle before collection ends.
    const kinds = signals.map((s) => s.kind);
    expect(kinds.indexOf("checkpoint.captured")).toBeLessThan(kinds.indexOf("harness.started"));
    expect(kinds.lastIndexOf("checkpoint.captured")).toBeLessThan(kinds.indexOf("collect.complete"));
    // The stale worktree-intent-to-add command is gone from the trail.
    expect(ops.commands.some((c) => c.includes("'add' '-N'"))).toBe(false);
  });

  it("exports an oversize diff via the hook and receipts the storage key", async () => {
    const big = `diff --git a/x\n${"+".repeat(130_000)}\n`;
    const ops = gitOps({ diffOut: big });
    const exported: string[] = [];
    const signals: RunSignal[] = [];
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {}, {
      signals,
      exportDiff: async (diff) => {
        exported.push(diff);
        return "diffs/run-abcdef12345678.patch";
      },
    });
    expect(result.status).toBe("completed");
    expect(exported).toEqual([big]);
    expect(signals.find((s) => s.kind === "diff.exported")?.detail).toBe("diffs/run-abcdef12345678.patch");
    // The result still carries the capped tail.
    expect(result.diff.length).toBeLessThanOrEqual(120_040);
  });

  it("T46 gate: a run with no diff and no proof settles error, not completed", async () => {
    const ops = gitOps({ diffOut: "" });
    // Overwrite the status answer too: no diff AND no changed files AND no
    // test evidence is a fake success, not a completed run.
    const base = ops.exec.bind(ops);
    ops.exec = async (command, opts) =>
      command.includes("status")
        ? { stdout: "", stderr: "", exitCode: 0 }
        : base(command, opts);
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {}, {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Verification failed");
  });

  it("T46: a docs-only diff (no app, no testCommand) still completes on diff evidence", async () => {
    const ops = gitOps({ diffOut: "diff --git a/README.md b/README.md\n+docs\n" });
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {}, {});
    expect(result.status).toBe("completed");
    expect(result.testEvidence).toBeUndefined();
    expect(result.diff).toContain("README.md");
  });
});
