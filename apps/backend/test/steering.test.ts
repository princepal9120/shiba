import { describe, expect, it } from "vitest";
import {
  appendSteeringNote,
  handleSteeringRequest,
  MAX_PENDING_STEERS_PER_RUN,
  MAX_PENDING_APPROVALS,
  planSteering,
  parseSteeringInput,
  runIdFromSteeringThreadKey,
  steeringThreadKey,
  type SteeringHost,
} from "../src/steering.js";
import { createPendingApproval, type PendingApproval } from "../src/pending-approvals.js";
import { createRun, transitionRun, type DelegatedRun, isActiveStatus } from "../src/runs.js";
import type { ApprovedRoute } from "../src/model-connections.js";

const ROUTE: ApprovedRoute = {
  purpose: "coding",
  connectionId: "conn-1",
  modelId: "google/gemini-2.5-pro",
  harness: "opencode",
  policyVersion: 1,
};

function makeRun(overrides: Partial<DelegatedRun> = {}): DelegatedRun {
  const base = createRun({
    runId: "agent-tool:run-1",
    sandboxId: "sbx-1",
    repoUrl: "https://github.com/acme/widgets",
    task: "Fix the flaky test",
    baseBranch: "main",
    publishPullRequest: false,
    queuedBy: "operator",
    route: ROUTE,
    now: 1_000,
  });
  return { ...base, ...overrides };
}

function makeHost(runs: DelegatedRun[] = [], approvals: PendingApproval[] = []): SteeringHost & {
  runs: DelegatedRun[];
  approvals: PendingApproval[];
  resolveCalls: unknown[];
  cancelledRuns: string[];
} {
  const host = {
    runs,
    approvals,
    resolveCalls: [] as unknown[],
    cancelledRuns: [] as string[],
    listRuns: () => host.runs,
    writeRuns: (next: DelegatedRun[]) => {
      host.runs = next;
    },
    listApprovals: () => host.approvals,
    writeApprovals: (next: PendingApproval[]) => {
      host.approvals = next;
    },
    cancelRun: (runId: string) => {
      host.cancelledRuns.push(runId);
      const current = host.runs.find((r) => r.runId === runId);
      if (!current || !isActiveStatus(current.status)) return current ?? null;
      const updated = transitionRun(current, "cancelled", { errorCode: "cancelled" });
      host.runs = host.runs.map((r) => (r.runId === runId ? updated : r));
      return updated;
    },
    resolveRoute: async (input: {
      harness?: string;
      codingModel?: string;
      connectionId?: string;
    }) => {
      host.resolveCalls.push(input);
      return {
        route: {
          ...ROUTE,
          ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
          modelId: input.codingModel ?? ROUTE.modelId,
          harness: (input.harness ?? ROUTE.harness) as ApprovedRoute["harness"],
        },
      };
    },
  };
  return host;
}

describe("T31 invariant — steering never bypasses the approval gate & cancels live-running work", () => {
  it("a scope-changing steer cancels/fences the live run, mints a pending approval and starts nothing", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, {
      message: "actually also patch the billing path",
      publishPullRequest: true,
      changesScope: true,
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, action: "reapproval", changedFields: ["task", "publishPullRequest", "changesScope"] });
    // Live run was cancelled/fenced so container execution is stopped and writes are dropped
    expect(host.cancelledRuns).toContain(run.runId);
    const stored = host.runs.find((candidate) => candidate.runId === run.runId)!;
    expect(stored.status).toBe("cancelled");
    expect(stored.generation).toBeGreaterThan(0);
    expect(stored.steering).toHaveLength(1);
    expect(stored.steering![0]!.kind).toBe("approval");

    // The approval is pending — undecided. No new run was created, no dispatch happened.
    expect(host.approvals).toHaveLength(1);
    const approval = host.approvals[0]!;
    expect(approval.status).toBe("pending");
    expect(approval.threadKey).toBe(steeringThreadKey(run.runId));
    expect(approval.publishPullRequest).toBe(true);
    expect(approval.task).toContain(run.task);
    expect(approval.task).toContain("actually also patch the billing path");
  });

  it("a reapproval freezes the effective input, not just the delta", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, {
      message: "move it to the release branch",
      baseBranch: "release/2026",
    });
    expect(res.status).toBe(202);
    const approval = host.approvals[0]!;
    expect(approval.baseBranch).toBe("release/2026");
    // Untouched envelope fields carry over frozen — repo, publish flag,
    // and the route all match the original approval.
    expect(approval.repoUrl).toBe(run.repoUrl);
    expect(approval.publishPullRequest).toBe(false);
    expect(approval.route).toEqual(ROUTE);
    expect(approval.task).toContain(run.task);
    expect(approval.task).toContain("move it to the release branch");
    // Live run was cancelled and fenced
    expect(host.runs[0]!.status).toBe("cancelled");
  });

  it("rejects combined task text over the cap before cancelling", async () => {
    const run = makeRun({ task: "x".repeat(4000) });
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, { message: "follow-up" });
    expect(res.status).toBe(400);
    expect(host.cancelledRuns).toHaveLength(0);
    expect(host.approvals).toHaveLength(0);
  });

  it("rejects PR publishing without a configured token before cancelling", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    host.githubTokenConfigured = false;
    const res = await handleSteeringRequest(host, run.runId, { message: "publish it", publishPullRequest: true });
    expect(res.status).toBe(400);
    expect(host.cancelledRuns).toHaveLength(0);
    expect(host.approvals).toHaveLength(0);
  });

  it("rejects invalid repository overrides before cancelling", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, { message: "change repo", repoUrl: "https://evil.test/a/b" });
    expect(res.status).toBe(400);
    expect(host.cancelledRuns).toHaveLength(0);
  });

  it("a text-only follow-up cancels/fences the live run and requires full new approval (never appends text only)", async () => {
    const run = makeRun({ status: "running" });
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, { message: "prefer vitest over jest" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, action: "reapproval" });
    // Live run must be canceled/fenced because one-shot harness does not consume mid-run text
    expect(host.cancelledRuns).toContain(run.runId);
    const stored = host.runs[0]!;
    expect(stored.status).toBe("cancelled");
    expect(stored.steering).toHaveLength(1);
    expect(stored.steering![0]!.kind).toBe("approval");

    // Full new approval is pending
    expect(host.approvals).toHaveLength(1);
    const approval = host.approvals[0]!;
    expect(approval.status).toBe("pending");
    expect(approval.task).toContain(run.task);
    expect(approval.task).toContain("prefer vitest over jest");
  });

  it("repeating the approved values still cancels the live run and requires reapproval for the steered task", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, {
      message: "same envelope, more detail",
      repoUrl: run.repoUrl,
      baseBranch: run.baseBranch,
      publishPullRequest: run.publishPullRequest,
      harness: ROUTE.harness,
      codingModel: ROUTE.modelId,
      connectionId: ROUTE.connectionId!,
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, action: "reapproval" });
    expect(host.cancelledRuns).toContain(run.runId);
    expect(host.approvals).toHaveLength(1);
  });
});

describe("steering admission", () => {
  it("refuses terminal runs", async () => {
    const run = transitionRun(makeRun(), "completed", { summary: "done" }, 2_000);
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, { message: "one more thing" });
    expect(res.status).toBe(409);
    expect(host.approvals).toHaveLength(0);
    expect(host.runs[0]!.steering).toBeUndefined();
  });

  it("rejects a steer to a harness outside the installed set — before any cancellation", async () => {
    const host = makeHost([makeRun()]);
    const res = await handleSteeringRequest(host, "agent-tool:run-1", {
      message: "switch to cursor",
      harness: "cursor",
    });
    expect(res.status).toBe(400);
    expect(host.cancelledRuns).toHaveLength(0);
    expect(host.approvals).toHaveLength(0);
    expect(host.runs[0]!.status).toBe("pending");
  });

  it("404s unknown runs and runs owned by another principal", async () => {
    const host = makeHost([makeRun()]);
    expect((await handleSteeringRequest(host, "agent-tool:nope", { message: "hi" })).status).toBe(404);
    const res = await handleSteeringRequest(host, "agent-tool:run-1", { message: "hi" }, { steeredBy: "someone-else" });
    expect(res.status).toBe(404);
  });

  it("scopes the steer note and approval to the vouched principal", async () => {
    const run = makeRun({ queuedBy: "agent:abc" });
    const host = makeHost([run]);
    const res = await handleSteeringRequest(
      host,
      run.runId,
      { message: "widen it", changesScope: true },
      { steeredBy: "agent:abc" },
    );
    expect(res.status).toBe(202);
    expect(host.approvals[0]!.queuedBy).toBe("agent:abc");
    expect(host.runs[0]!.steering![0]!.by).toBe("agent:abc");
  });

  it("falls back to the run's queuedBy when the steer is unattributed", async () => {
    const run = makeRun({ queuedBy: "agent:abc" });
    const host = makeHost([run]);
    await handleSteeringRequest(host, run.runId, { message: "widen", changesScope: true });
    expect(host.approvals[0]!.queuedBy).toBe("agent:abc");
  });
});

describe("steering flood guards", () => {
  it("caps pending steering approvals per run", async () => {
    const run = makeRun();
    const approvals = Array.from({ length: MAX_PENDING_STEERS_PER_RUN }, (_, index) => ({
      threadKey: steeringThreadKey(run.runId),
      approvalId: `steer-${index}`,
      repoUrl: run.repoUrl,
      task: "x",
      status: "pending" as const,
      createdAt: Date.now(),
    }));
    const host = makeHost([run], approvals);
    const res = await handleSteeringRequest(host, run.runId, { message: "more", changesScope: true });
    expect(res.status).toBe(429);
    expect(host.approvals).toHaveLength(MAX_PENDING_STEERS_PER_RUN);
  });

  it("the per-run cap counts only this run's steering approvals", async () => {
    const run = makeRun();
    const approvals = Array.from({ length: MAX_PENDING_STEERS_PER_RUN }, (_, index) => ({
      threadKey: steeringThreadKey(`agent-tool:other-${index}`),
      approvalId: `steer-${index}`,
      repoUrl: run.repoUrl,
      task: "x",
      status: "pending" as const,
      createdAt: Date.now(),
    }));
    const host = makeHost([run], approvals);
    const res = await handleSteeringRequest(host, run.runId, { message: "widen", changesScope: true });
    expect(res.status).toBe(202);
    expect(host.approvals).toHaveLength(MAX_PENDING_STEERS_PER_RUN + 1);
  });

  it("enforces the global pending-approval ceiling before cancelling", async () => {
    const run = makeRun();
    const approvals = Array.from({ length: MAX_PENDING_APPROVALS }, (_, index) => ({
      threadKey: `thread-${index}`,
      approvalId: `appr-${index}`,
      repoUrl: run.repoUrl,
      task: "x",
      status: "pending" as const,
      createdAt: Date.now(),
    }));
    const host = makeHost([run], approvals);
    const res = await handleSteeringRequest(host, run.runId, { message: "widen", changesScope: true });
    expect(res.status).toBe(429);
    expect(host.cancelledRuns).toHaveLength(0);
    expect(host.approvals).toHaveLength(MAX_PENDING_APPROVALS);
  });

  it("decided and expired steering approvals do not count against the cap", async () => {
    const run = makeRun();
    const decided = createPendingApproval([], {
      threadKey: steeringThreadKey(run.runId),
      approvalId: "decided-1",
      repoUrl: run.repoUrl,
      task: "x",
      createdAt: Date.now(),
    }).map((approval) => ({ ...approval, status: "rejected" as const }));
    const host = makeHost([run], decided);
    const res = await handleSteeringRequest(host, run.runId, { message: "widen", changesScope: true });
    expect(res.status).toBe(202);
  });

  it("bounds retained steering notes", () => {
    let run = makeRun();
    for (let index = 0; index < 40; index += 1) {
      run = appendSteeringNote(run, { at: index, message: `note ${index}`, kind: "queued" });
    }
    expect(run.steering!.length).toBe(32);
    expect(run.steering![0]!.message).toBe("note 8");
  });
});

describe("route-changing steers", () => {
  it("re-resolves through the host and freezes the resolved route", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, {
      message: "switch to the cheaper model",
      codingModel: "google/gemini-2.5-flash",
    });
    expect(res.status).toBe(202);
    expect(host.resolveCalls).toHaveLength(1);
    expect(host.approvals[0]!.route!.modelId).toBe("google/gemini-2.5-flash");
    expect(host.approvals[0]!.route!.harness).toBe(ROUTE.harness);
  });

  it("fails closed when route resolution rejects", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    host.resolveRoute = async () => {
      throw new Error("provider not allowlisted");
    };
    const res = await handleSteeringRequest(host, run.runId, { message: "swap model", codingModel: "evil/model" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not allowlisted");
    expect(host.approvals).toHaveLength(0);
  });

  it("fails closed when the host cannot re-resolve routes", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    delete (host as { resolveRoute?: unknown }).resolveRoute;
    const res = await handleSteeringRequest(host, run.runId, { message: "swap", harness: "claude-code" });
    expect(res.status).toBe(400);
    expect(host.approvals).toHaveLength(0);
  });

  it("any route field on a legacy unrouted run forces reapproval", () => {
    const legacy = makeRun();
    delete (legacy as { route?: ApprovedRoute }).route;
    const plan = planSteering(legacy, { message: "use opencode", harness: "opencode" });
    expect(plan.action).toBe("reapproval");
    expect(plan.changedFields).toContain("harness");
  });
});

describe("route override edge cases", () => {
  it("a route field restating its approved value is not a route change — no re-resolution", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, {
      message: "same harness, more detail",
      harness: ROUTE.harness,
      codingModel: ROUTE.modelId,
      connectionId: ROUTE.connectionId!,
    });
    expect(res.status).toBe(202);
    expect(host.resolveCalls).toHaveLength(0);
    expect(res.body).toMatchObject({
      changedFields: ["task"],
    });
    expect(host.approvals[0]!.route).toEqual(ROUTE);
  });

  it("a partial override preserves the untouched frozen route fields", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    const res = await handleSteeringRequest(host, run.runId, {
      message: "same harness, cheaper model",
      codingModel: "google/gemini-2.5-flash",
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ changedFields: ["task", "codingModel"] });
    // The re-resolve received the frozen harness + connection, not defaults
    expect(host.resolveCalls[0]).toMatchObject({
      harness: ROUTE.harness,
      connectionId: ROUTE.connectionId,
      codingModel: "google/gemini-2.5-flash",
    });
    expect(host.approvals[0]!.route!.connectionId).toBe(ROUTE.connectionId);
    expect(host.approvals[0]!.route!.harness).toBe(ROUTE.harness);
  });
});

describe("async recheck and cancellation truth", () => {
  it("re-checks the run is still active after route resolution yields", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    host.resolveRoute = async (input: unknown) => {
      host.resolveCalls.push(input);
      // The run finishes while the steer awaits route resolution.
      host.runs = host.runs.map((candidate) =>
        candidate.runId === run.runId
          ? transitionRun(candidate, "completed", { summary: "done" }, Date.now())
          : candidate,
      );
      return { route: { ...ROUTE, modelId: "google/gemini-2.5-flash" } };
    };
    const res = await handleSteeringRequest(host, run.runId, {
      message: "swap model",
      codingModel: "google/gemini-2.5-flash",
    });
    expect(res.status).toBe(409);
    // Nothing was cancelled and no approval was minted for a dead run.
    expect(host.cancelledRuns).toHaveLength(0);
    expect(host.approvals).toHaveLength(0);
    expect(host.runs[0]!.status).toBe("completed");
  });

  it("re-checks the pending caps after route resolution yields", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    host.resolveRoute = async (input: unknown) => {
      host.resolveCalls.push(input);
      // Concurrent approvals flood the board while we awaited resolution.
      host.approvals = Array.from({ length: MAX_PENDING_APPROVALS }, (_, index) => ({
        threadKey: `thread-${index}`,
        approvalId: `appr-${index}`,
        repoUrl: run.repoUrl,
        task: "x",
        status: "pending" as const,
        createdAt: Date.now(),
      }));
      return { route: { ...ROUTE, modelId: "google/gemini-2.5-flash" } };
    };
    const res = await handleSteeringRequest(host, run.runId, {
      message: "swap model",
      codingModel: "google/gemini-2.5-flash",
    });
    expect(res.status).toBe(429);
    expect(host.cancelledRuns).toHaveLength(0);
  });

  it("fails when cancellation does not actually cancel the run", async () => {
    const run = makeRun();
    const host = makeHost([run]);
    host.cancelRun = async () => host.runs.find((candidate) => candidate.runId === run.runId) ?? null;
    const res = await handleSteeringRequest(host, run.runId, { message: "widen", changesScope: true });
    expect(res.status).toBe(409);
    // Cancellation was attempted, reported untruthfully, and no approval
    // was minted — the run keeps its live status untouched.
    expect(host.cancelledRuns).toHaveLength(0);
    expect(host.approvals).toHaveLength(0);
    expect(host.runs[0]!.status).not.toBe("cancelled");
  });
});

describe("parseSteeringInput", () => {
  it("rejects non-object bodies and empty messages", () => {
    expect(parseSteeringInput(null).ok).toBe(false);
    expect(parseSteeringInput([]).ok).toBe(false);
    expect(parseSteeringInput({ message: "   " }).ok).toBe(false);
    expect(parseSteeringInput({}).ok).toBe(false);
  });

  it("rejects wrong-typed optional fields", () => {
    expect(parseSteeringInput({ message: "x", publishPullRequest: "yes" }).ok).toBe(false);
    expect(parseSteeringInput({ message: "x", baseBranch: 42 }).ok).toBe(false);
    expect(parseSteeringInput({ message: "x", changesScope: "true" }).ok).toBe(false);
  });

  it("caps the message at 4000 chars", () => {
    expect(parseSteeringInput({ message: "y".repeat(4001) }).ok).toBe(false);
    const ok = parseSteeringInput({ message: "y".repeat(4000) });
    expect(ok.ok).toBe(true);
  });
});

describe("steering thread keys", () => {
  it("round-trips the run id", () => {
    expect(runIdFromSteeringThreadKey(steeringThreadKey("agent-tool:run-9"))).toBe("agent-tool:run-9");
    expect(runIdFromSteeringThreadKey("default")).toBeNull();
  });
});
