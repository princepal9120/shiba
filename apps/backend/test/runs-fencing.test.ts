import { describe, expect, it } from "vitest";
import {
  createRun,
  isActiveStatus,
  isTerminalStatus,
  reclaimStaleRuns,
  RUN_DEADLINE_MS,
  RunStore,
  transitionRun,
  type DelegatedRun,
} from "../src/runs.js";

function makeRun(overrides: Partial<DelegatedRun> = {}): DelegatedRun {
  return {
    ...createRun({
      runId: "r1",
      sandboxId: "s1",
      repoUrl: "https://github.com/o/r",
      task: "fix",
      baseBranch: "main",
      publishPullRequest: false,
      now: 1000,
    }),
    ...overrides,
  };
}

function makeStore(initial: DelegatedRun[]) {
  let runs = initial;
  const store = new RunStore(
    () => runs,
    (next) => {
      runs = next;
    },
  );
  return { store, runs: () => runs };
}

describe("generation fencing", () => {
  it("createRun starts at generation 0; each transitionRun bumps it", () => {
    const run = makeRun();
    expect(run.generation).toBe(0);
    const running = transitionRun(run, "running", undefined, 2000);
    expect(running.generation).toBe(1);
    const done = transitionRun(running, "completed", { summary: "ok" }, 3000);
    expect(done.generation).toBe(2);
  });

  it("terminal transitions do not bump generation (no-op)", () => {
    const done = transitionRun(transitionRun(makeRun(), "running", undefined, 2), "completed", {}, 3);
    const after = transitionRun(done, "error", { error: "late" }, 4);
    expect(after).toBe(done);
    expect(after.generation).toBe(done.generation);
  });

  it("normalizes a legacy run without generation to 0 on store reads", () => {
    const legacy = makeRun() as Partial<DelegatedRun> & { status: DelegatedRun["status"] };
    delete legacy.generation;
    const { store, runs } = makeStore([legacy as DelegatedRun]);
    expect(store.get("r1")?.generation).toBe(0);
    expect(store.list()[0]?.generation).toBe(0);
    const updated = store.transition("r1", "running");
    expect(updated?.generation).toBe(1);
    expect(Number.isNaN(runs()[0]?.generation)).toBe(false);
    expect(runs()[0]?.generation).toBe(1);
  });

  it("transition succeeds with matching expectedGeneration", () => {
    const { store } = makeStore([transitionRun(makeRun(), "running", undefined, 1)]);
    const updated = store.transition("r1", "completed", { summary: "ok" }, 1);
    expect(updated?.status).toBe("completed");
    expect(updated?.generation).toBe(2);
  });

  it("transition returns null and writes nothing on stale expectedGeneration", () => {
    const { store, runs } = makeStore([transitionRun(makeRun(), "running", undefined, 1)]);
    const before = runs()[0];
    const stale = store.transition("r1", "completed", { summary: "late write" }, 0);
    expect(stale).toBeNull();
    const after = runs()[0];
    expect(after).toEqual(before);
    expect(after?.status).toBe("running");
    expect(after?.generation).toBe(1);
    expect(after?.receipts).toHaveLength(before?.receipts?.length ?? 0);
  });

  it("transition without expectedGeneration is unfenced", () => {
    const { store } = makeStore([transitionRun(makeRun(), "running", undefined, 1)]);
    expect(store.transition("r1", "completed")?.status).toBe("completed");
  });
});

describe("unknown status", () => {
  it("reclaimStaleRuns marks stale runs unknown with outcome_unknown", () => {
    const stale = makeRun({ status: "running", updatedAt: 1000 });
    const { runs, reclaimed } = reclaimStaleRuns([stale], 1000 + RUN_DEADLINE_MS + 1);
    expect(reclaimed).toEqual(["r1"]);
    const run = runs[0];
    expect(run?.status).toBe("unknown");
    expect(run?.errorCode).toBe("outcome_unknown");
    expect(run?.error).toMatch(/unverified/i);
    expect(isTerminalStatus(run!.status)).toBe(true);
    expect(isActiveStatus(run!.status)).toBe(false);
  });

  it("transitionRun on unknown is a terminal no-op", () => {
    const run = { ...makeRun(), status: "unknown" as const, errorCode: "outcome_unknown" as const };
    const next = transitionRun(run, "error", { error: "late" });
    expect(next.status).toBe("unknown");
    expect(next.error).toBeUndefined();
  });

  it("completed/error/cancelled stay terminal; pending/running stay active", () => {
    for (const s of ["completed", "error", "cancelled", "aborted", "unknown"] as const) {
      expect(isTerminalStatus(s)).toBe(true);
      expect(isActiveStatus(s)).toBe(false);
    }
    for (const s of ["pending", "running"] as const) {
      expect(isActiveStatus(s)).toBe(true);
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});
