/**
 * T43 — HarnessCapabilities + verify() gate (PLAN.md §18.4).
 *
 * Pins: (1) every harness's declared capabilities round-trip through the
 * interface; (2) verify rejects an exit-0/empty-diff run — it is NOT
 * completed; (3) the runnability gate still refuses non-sandbox harnesses,
 * now via the capability rather than a name list.
 */
import { describe, expect, it } from "vitest";
import { resolveHarness, harnessRunsOn, harnessIsGated, HARNESSES, SANDBOX_HARNESS_NAMES } from "../src/harness/index.js";
import type { CodingTaskInput, CodingTaskResult } from "../src/opencode-input.js";
import type { AgentHarnessName, HarnessCapabilities } from "../src/harness/types.js";

const CAPABILITY_KEYS = [
  "streamsText",
  "emitsToolCalls",
  "supportsResume",
  "supportsSteering",
  "supportsFileAttachments",
  "canRunTests",
  "supportsConversationRollback",
  "supportedRuntimes",
] as const;

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
  task: "edit src/a.ts",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

function completedResult(overrides: Partial<CodingTaskResult> = {}): CodingTaskResult {
  return {
    status: "completed",
    exitCode: 0,
    stderrTail: "",
    changedFiles: ["src/a.ts"],
    diff: "diff --git a/src/a.ts",
    files: [{ path: "src/a.ts", content: "x", encoding: "utf8" }],
    summary: "done",
    ...overrides,
  };
}

describe("declared capabilities", () => {
  it("every harness's declared capabilities round-trip", () => {
    for (const [name, harness] of Object.entries(HARNESSES)) {
      const caps: HarnessCapabilities = harness.capabilities();
      expect(caps, name).toBeTypeOf("object");
      for (const key of CAPABILITY_KEYS) {
        expect(caps[key], `${name}.${key}`).not.toBeUndefined();
      }
      expect(harness.name).toBe(name as AgentHarnessName);
      // supportedRuntimes is an honest list of RuntimeName members.
      for (const runtime of caps.supportedRuntimes) {
        expect(["sandbox", "computer", "local"]).toContain(runtime);
      }
      // model-dependent capabilities resolve without throwing.
      expect(() => harness.capabilities("google/gemini-3.5-flash-lite")).not.toThrow();
    }
  });

  it("derives the sandbox set from capabilities, not a parallel list", () => {
    // T48: opt-in-gated harnesses (claude-subscription) declare the sandbox
    // runtime but are only selectable through sandboxHarnessNames(env) — the
    // static list is the always-on set.
    expect([...SANDBOX_HARNESS_NAMES].sort()).toEqual(
      Object.values(HARNESSES)
        .filter((h) => h.capabilities().supportedRuntimes.includes("sandbox") && !harnessIsGated(h))
        .map((h) => h.name)
        .sort(),
    );
    expect(SANDBOX_HARNESS_NAMES).toContain("opencode");
    expect(SANDBOX_HARNESS_NAMES).not.toContain("cursor");
    expect(SANDBOX_HARNESS_NAMES).not.toContain("antigravity");
  });

  it("declares antigravity's supportsConversationRollback trap as false", () => {
    expect(HARNESSES.antigravity!.capabilities().supportsConversationRollback).toBe(false);
  });
});

describe("verify gate", () => {
  it("rejects a completed result with exit 0 and an empty diff", async () => {
    const empty = completedResult({ changedFiles: [], diff: "", files: [] });
    for (const [name, harness] of Object.entries(HARNESSES)) {
      const verdict = await harness.verify(INPUT, empty);
      expect(verdict, name).toEqual({ ok: false, reason: expect.stringContaining("no file changes") });
    }
  });

  it("accepts a completed result with captured changes", async () => {
    const verdict = await HARNESSES.opencode!.verify(INPUT, completedResult());
    expect(verdict).toEqual({ ok: true });
  });

  it("does not gate non-completed results", async () => {
    const failed = completedResult({ status: "error", summary: "boom" });
    expect(await HARNESSES.opencode!.verify(INPUT, failed)).toEqual({ ok: true });
  });
});

describe("runnability gate via capability", () => {
  it("still refuses non-sandbox harnesses — via supportedRuntimes, not name", () => {
    expect(() => resolveHarness("cursor")).toThrow(/not runnable in a sandbox/);
    expect(() => resolveHarness("antigravity")).toThrow(/not runnable in a sandbox/);
    // The refusal reads the declaration: cursor declares no runtimes.
    expect(HARNESSES.cursor!.capabilities().supportedRuntimes).toEqual([]);
    expect(harnessRunsOn(HARNESSES.cursor!, "sandbox")).toBe(false);
    expect(harnessRunsOn(HARNESSES.opencode!, "sandbox")).toBe(true);
  });

  it("resolves every capability-declared sandbox harness", () => {
    for (const name of SANDBOX_HARNESS_NAMES) {
      expect(resolveHarness(name).name).toBe(name);
    }
  });
});
