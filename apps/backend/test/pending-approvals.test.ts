import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  createPendingApproval,
  DECIDED_APPROVALS_LIMIT,
  decidedApprovals,
  MAX_PENDING_APPROVALS,
  pruneApprovals,
  pruneExpiredApprovals,
  resolvePendingApproval,
} from "../src/pending-approvals.js";
import {
  reclaimStaleRuns,
  transitionRun,
  RUN_DEADLINE_MS,
  type DelegatedRun,
} from "../src/runs.js";

const POINTER = { threadKey: "slack:T:C:1.2", approvalId: "a-1" };

function run(overrides: Partial<DelegatedRun> = {}): DelegatedRun {
  return {
    runId: "r1",
    sandboxId: "run-abc",
    repoUrl: "https://github.com/o/r",
    task: "t",
    baseBranch: "main",
    publishPullRequest: false,
    status: "running",
    generation: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("pending approvals (#2)", () => {
  it("creates a pending approval with a timestamp", () => {
    const approvals = createPendingApproval([], { ...POINTER, repoUrl: "https://github.com/o/r", task: "t", createdAt: 100 });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ ...POINTER, status: "pending" });
  });

  it("refuses a duplicate approvalId", () => {
    const seeded = createPendingApproval([], { ...POINTER, repoUrl: "r", task: "t", createdAt: 100 });
    expect(() =>
      createPendingApproval(seeded, { threadKey: POINTER.threadKey, approvalId: "a-1", repoUrl: "r", task: "t", createdAt: 200 }),
    ).toThrow(/already pending|duplicate/i);
  });

  it("resolves a pending approval exactly once", () => {
    let approvals = createPendingApproval([], { ...POINTER, repoUrl: "r", task: "t", createdAt: 0 });
    const first = resolvePendingApproval(approvals, { ...POINTER, approved: true, decidedBy: "U1" }, 500);
    expect(first.result).toBe("approved");
    approvals = first.approvals;
    const replay = resolvePendingApproval(approvals, { ...POINTER, approved: true, decidedBy: "U1" }, 600);
    expect(replay.result).toBe("unknown");
  });

  it("returns unknown for a pointer that never existed", () => {
    const out = resolvePendingApproval([], { threadKey: "x", approvalId: "nope", approved: false, decidedBy: "U1" }, 0);
    expect(out.result).toBe("unknown");
  });

  it("treats an expired approval as unknown and prunes it", () => {
    let approvals = createPendingApproval([], { ...POINTER, repoUrl: "r", task: "t", createdAt: 0 });
    const out = resolvePendingApproval(approvals, { ...POINTER, approved: true, decidedBy: "U1" }, APPROVAL_TTL_MS + 1);
    expect(out.result).toBe("unknown");
    expect(out.approvals).toHaveLength(0);
    approvals = out.approvals;
    expect(approvals).toHaveLength(0);
    void approvals;
  });
});

describe("run deadline (#6)", () => {
  it("reclaims a running run past its deadline as unknown", () => {
    const stale = run({ updatedAt: 0 });
    const out = reclaimStaleRuns([stale], RUN_DEADLINE_MS + 10);
    expect(out.reclaimed).toEqual(["r1"]);
    expect(out.runs[0]?.status).toBe("unknown");
    expect(out.runs[0]?.errorCode).toBe("outcome_unknown");
    expect(out.runs[0]?.error).toContain("deadline");
  });

  it("leaves fresh running runs and terminal runs alone", () => {
    const fresh = run({ updatedAt: 5 });
    const done = run({ runId: "r2", status: "completed", updatedAt: 0 });
    const out = reclaimStaleRuns([fresh, done], 10);
    expect(out.reclaimed).toEqual([]);
    expect(out.runs[0]?.status).toBe("running");
  });

  it("never lets a late finish resurrect a terminal run", () => {
    const out = reclaimStaleRuns([run()], RUN_DEADLINE_MS + 10);
    const expired = out.runs[0]!;
    expect(transitionRun(expired, "completed", { summary: "late result" }, RUN_DEADLINE_MS + 20)).toEqual(expired);
  });
});

describe("approval bookkeeping", () => {
  it("freezes the exact delegation input at queue time", () => {
    const approvals = createPendingApproval([], {
      ...POINTER, repoUrl: "https://github.com/o/r", task: "fix it",
      baseBranch: "develop", publishPullRequest: true, createdAt: 100,
    });
    expect(approvals[0]).toMatchObject({ baseBranch: "develop", publishPullRequest: true, status: "pending" });
  });

  it("prunes expired pending records but keeps resolved ones for audit", () => {
    let approvals = createPendingApproval([], { ...POINTER, repoUrl: "r", task: "t", createdAt: 0 });
    approvals = createPendingApproval(approvals, { threadKey: "slack:T:C:2.2", approvalId: "a-2", repoUrl: "r", task: "t", createdAt: 0 });
    approvals = resolvePendingApproval(approvals, { ...POINTER, approved: true, decidedBy: "U1" }, 10).approvals;
    const pruned = pruneExpiredApprovals(approvals, APPROVAL_TTL_MS + 1);
    expect(pruned.map((a) => a.approvalId).sort()).toEqual(["a-1"]); // resolved a-1 stays, expired pending a-2 goes
  });
});

describe("queue ceiling + decided retention", () => {
  it("createPendingApproval refuses to mint past the shared pending cap", () => {
    let approvals = createPendingApproval([], { ...POINTER, repoUrl: "r", task: "t", createdAt: 0 });
    for (let i = 1; i < MAX_PENDING_APPROVALS; i += 1) {
      approvals = createPendingApproval(approvals, {
        threadKey: "default",
        approvalId: `fill-${i}`,
        repoUrl: "r",
        task: "t",
        createdAt: 0,
      });
    }
    expect(() =>
      createPendingApproval(approvals, {
        threadKey: "default",
        approvalId: "a-over",
        repoUrl: "r",
        task: "t",
        createdAt: 1,
      }),
    ).toThrow(/full/i);
    // Decided records don't count toward the cap — resolving one frees a slot.
    approvals = resolvePendingApproval(
      approvals,
      { ...POINTER, approved: true, decidedBy: "U1" },
      2,
    ).approvals;
    expect(
      createPendingApproval(approvals, {
        threadKey: "default",
        approvalId: "a-over",
        repoUrl: "r",
        task: "t",
        createdAt: 3,
      }),
    ).toHaveLength(MAX_PENDING_APPROVALS + 1);
  });

  it("pruneApprovals keeps every pending record and evicts decided history past the listing's tail", () => {
    let approvals = createPendingApproval([], { ...POINTER, repoUrl: "r", task: "t", createdAt: 0 });
    // Decide DECIDED_APPROVALS_LIMIT + 10 records, oldest first.
    for (let i = 1; i <= DECIDED_APPROVALS_LIMIT + 10; i += 1) {
      approvals = createPendingApproval(approvals, {
        threadKey: "default",
        approvalId: `d-${i}`,
        repoUrl: "r",
        task: "t",
        createdAt: 0,
      });
      approvals = resolvePendingApproval(
        approvals,
        { threadKey: "default", approvalId: `d-${i}`, approved: i % 2 === 0, decidedBy: "U1" },
        i,
      ).approvals;
    }
    const pruned = pruneApprovals(approvals, 1_000);
    // The still-pending pointer survives; the decided tail is exactly
    // what the listing serves — nothing starved, nothing extra kept.
    expect(pruned.filter((a) => a.status === "pending")).toHaveLength(1);
    expect(pruned.filter((a) => a.status !== "pending")).toHaveLength(DECIDED_APPROVALS_LIMIT);
    expect(decidedApprovals(pruned)).toEqual(decidedApprovals(approvals));
    const kept = pruned.map((a) => a.approvalId);
    expect(kept).toContain(`d-${DECIDED_APPROVALS_LIMIT + 10}`);
    expect(kept).not.toContain("d-1");
  });
});
