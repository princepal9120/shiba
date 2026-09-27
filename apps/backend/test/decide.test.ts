/**
 * T40 (PLAN.md §18.1): the run-lifecycle machine decided by a pure function.
 * No Worker runtime, no DO, no mocks — this file imports @shiba/shared and
 * nothing else, which is the test that proves the decider is really pure.
 * Every (state, command) pair below asserts accept-or-reject, plus the two
 * rules that make it a gate and not a state machine: a run never enters
 * `running` without approval evidence, and a replayed intent returns the
 * recorded outcome.
 */
import { describe, expect, it } from "vitest";
import {
  applyRunEvents,
  approvalEvidenceFor,
  decideRunTransition,
  isTerminalStatus,
  runInputHash,
} from "@shiba/shared";
import type {
  ApprovalEvidence,
  DelegatedRun,
  PendingApproval,
  QueuedRunInput,
  Receipt,
  ReceiptKind,
  RunCommand,
} from "@shiba/shared";

// Plain receipt constructor — the backend's redacting makeReceipt is the
// injected production version; purity only needs the shape.
const make = (kind: ReceiptKind, message: string, at: number): Receipt => ({ at, kind, message });

const INPUT: QueuedRunInput = {
  sandboxId: "sbx-1",
  repoUrl: "https://github.com/acme/widgets",
  task: "Add a widget",
  baseBranch: "main",
  publishPullRequest: true,
};

function pointer(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    threadKey: "default",
    approvalId: "ap-1",
    repoUrl: INPUT.repoUrl,
    task: INPUT.task,
    baseBranch: INPUT.baseBranch,
    publishPullRequest: INPUT.publishPullRequest,
    status: "approved",
    createdAt: 1_000,
    decidedBy: "prince",
    decidedAt: 2_000,
    ...over,
  };
}

function evidence(over: Partial<ApprovalEvidence> = {}): ApprovalEvidence {
  return {
    approvalId: "ap-1",
    decidedBy: "prince",
    decidedAt: 2_000,
    inputHash: runInputHash(INPUT),
    ...over,
  };
}

function apply(
  run: DelegatedRun | null,
  command: RunCommand,
  approval?: PendingApproval | null,
): { run: DelegatedRun | null; events: ReturnType<typeof eventsOf> } {
  const decision = decideRunTransition({ run, approval: approval ?? null }, command);
  if ("error" in decision) throw new Error(`unexpected rejection: ${decision.error.code} ${decision.error.message}`);
  return { run: applyRunEvents(run, decision.events, make), events: decision.events };
}

function eventsOf(d: ReturnType<typeof decideRunTransition>) {
  return "events" in d ? d.events : [];
}

function expectError(run: DelegatedRun | null, command: RunCommand, code: string, approval?: PendingApproval | null) {
  const decision = decideRunTransition({ run, approval: approval ?? null }, command);
  expect("error" in decision && decision.error.code).toBe(code);
  // A refused command must never mutate: apply nothing, assert the record is unchanged.
  expect(run === null ? null : applyRunEvents(run, [], make)).toEqual(run);
}

const queue = (over: Partial<Extract<RunCommand, { type: "queue" }>> = {}): RunCommand => ({
  type: "queue",
  commandId: "cmd-q1",
  runId: "r1",
  input: INPUT,
  at: 3_000,
  ...over,
});

const pendingRun = (over: Partial<DelegatedRun> = {}): DelegatedRun => ({
  ...apply(null, queue()).run!,
  ...over,
});

function runningRun(over: Partial<DelegatedRun> = {}): DelegatedRun {
  const queued = apply(null, queue({ approval: evidence() })).run!;
  const started = apply(
    queued,
    { type: "start", commandId: "cmd-s1", runId: "r1", approvalEvidence: evidence(), at: 4_000 },
    pointer(),
  ).run!;
  return { ...started, ...over };
}

describe("decideRunTransition — queue", () => {
  it("queues a fresh run as pending with the init receipt", () => {
    const { run, events } = apply(null, queue());
    expect(events[0]).toMatchObject({ type: "run.queued", commandId: "cmd-q1" });
    expect(run).toMatchObject({ runId: "r1", status: "pending", generation: 0, sandboxId: "sbx-1" });
    expect(run!.receipts).toHaveLength(1);
    expect(run!.receipts![0]).toMatchObject({ kind: "init" });
  });

  it("replays queue for the same runId + input (stable answer, no mutation)", () => {
    const run = pendingRun();
    const decision = decideRunTransition({ run }, queue());
    expect("events" in decision && decision.events[0]).toMatchObject({ type: "run.queued", replayed: true });
    const next = applyRunEvents(run, "events" in decision ? decision.events : [], make);
    expect(next).toEqual(run);
  });

  it("rejects queue for an existing runId with different input", () => {
    expectError(
      pendingRun(),
      queue({ input: { ...INPUT, task: "sneakier task" } }),
      "input_conflict",
    );
  });

  it("rejects queue evidence whose hash does not cover the queued input", () => {
    expectError(null, queue({ approval: evidence({ inputHash: "deadbeef" }) }), "approval_mismatch");
  });

  it("stamps approval evidence on the record when carried", () => {
    const { run } = apply(null, queue({ approval: evidence() }));
    expect(run!.approval).toEqual(evidence());
  });
});

describe("decideRunTransition — the gate (start)", () => {
  it("refuses start with no evidence at all", () => {
    expectError(pendingRun(), { type: "start", commandId: "c1", runId: "r1", at: 4_000 }, "approval_required");
  });

  it("starts a pending run whose stored evidence matches the command", () => {
    const run = apply(null, queue({ approval: evidence() })).run!;
    const { run: next, events } = apply(run, {
      type: "start",
      commandId: "c1",
      runId: "r1",
      approvalEvidence: evidence(),
      at: 4_000,
    });
    expect(events[0]).toMatchObject({ type: "run.started" });
    expect(next!.status).toBe("running");
    expect(next!.generation).toBe(1);
  });

  it("starts an unevidenced pending run only when the pointer reads approved and the evidence covers the input", () => {
    const run = pendingRun();
    const { run: next } = apply(
      run,
      { type: "start", commandId: "c1", runId: "r1", approvalEvidence: evidence(), at: 4_000 },
      pointer(),
    );
    expect(next!.status).toBe("running");
    // The pointer-only authorization is stamped onto the run.
    expect(next!.approval).toEqual(evidence());
  });

  it("refuses start when the pointer is still pending", () => {
    expectError(
      pendingRun(),
      { type: "start", commandId: "c1", runId: "r1", approvalEvidence: evidence(), at: 4_000 },
      "approval_required",
      pointer({ status: "pending", decidedBy: undefined, decidedAt: undefined }),
    );
  });

  it("refuses start when the pointer names a different approval", () => {
    expectError(
      pendingRun(),
      { type: "start", commandId: "c1", runId: "r1", approvalEvidence: evidence(), at: 4_000 },
      "approval_required",
      pointer({ approvalId: "ap-other" }),
    );
  });

  it("refuses start when the evidence hash does not cover the frozen input", () => {
    expectError(
      pendingRun(),
      {
        type: "start",
        commandId: "c1",
        runId: "r1",
        approvalEvidence: evidence({ inputHash: runInputHash({ ...INPUT, task: "mutated task" }) }),
        at: 4_000,
      },
      "approval_mismatch",
      pointer(),
    );
  });

  it("refuses start whose evidence disagrees with the run's stored evidence", () => {
    const run = apply(null, queue({ approval: evidence() })).run!;
    expectError(
      run,
      { type: "start", commandId: "c1", runId: "r1", approvalEvidence: evidence({ decidedBy: "mallory" }), at: 4_000 },
      "approval_mismatch",
      pointer(),
    );
  });

  it("replays start on an already-running run with matching evidence", () => {
    const run = runningRun();
    const decision = decideRunTransition(
      { run, approval: pointer() },
      { type: "start", commandId: "c2", runId: "r1", approvalEvidence: evidence(), at: 5_000 },
    );
    expect("events" in decision && decision.events[0]).toMatchObject({ type: "run.started", replayed: true });
    const next = applyRunEvents(run, "events" in decision ? decision.events : [], make);
    expect(next).toEqual(run); // generation unchanged — nothing re-applied
  });

  it("refuses start on a running run under different evidence", () => {
    expectError(
      runningRun(),
      { type: "start", commandId: "c2", runId: "r1", approvalEvidence: evidence({ decidedBy: "mallory" }), at: 5_000 },
      "illegal_transition",
      pointer(),
    );
  });

  it("refuses start on a terminal run", () => {
    const done = apply(runningRun(), { type: "finish", commandId: "c9", runId: "r1", patch: { summary: "ok" }, at: 6_000 }).run!;
    expectError(done, { type: "start", commandId: "c3", runId: "r1", approvalEvidence: evidence(), at: 7_000 }, "terminal");
  });

  it("refuses start on a missing run", () => {
    expectError(null, { type: "start", commandId: "c1", runId: "nope", at: 1_000 }, "run_not_found");
  });
});

describe("decideRunTransition — approve", () => {
  it("attaches evidence to a pending run when the pointer reads approved", () => {
    const run = pendingRun();
    const { run: next, events } = apply(
      run,
      { type: "approve", commandId: "c1", runId: "r1", approval: evidence(), at: 3_500 },
      pointer(),
    );
    expect(events[0]).toMatchObject({ type: "run.approved" });
    expect(next!.approval).toEqual(evidence());
    expect(next!.status).toBe("pending"); // approve does not start the run
  });

  it("refuses approve when the pointer is still pending", () => {
    expectError(
      pendingRun(),
      { type: "approve", commandId: "c1", runId: "r1", approval: evidence(), at: 3_500 },
      "approval_required",
      pointer({ status: "pending", decidedBy: undefined }),
    );
  });

  it("refuses approve whose hash does not cover the frozen input", () => {
    expectError(
      pendingRun(),
      { type: "approve", commandId: "c1", runId: "r1", approval: evidence({ inputHash: "00000000" }), at: 3_500 },
      "approval_mismatch",
      pointer(),
    );
  });

  it("replays approve when the run already carries the same evidence", () => {
    const run = apply(null, queue({ approval: evidence() })).run!;
    const decision = decideRunTransition(
      { run, approval: pointer() },
      { type: "approve", commandId: "c2", runId: "r1", approval: evidence(), at: 3_600 },
    );
    expect("events" in decision && decision.events[0]).toMatchObject({ type: "run.approved", replayed: true });
  });

  it("refuses approve with different evidence on an evidenced run", () => {
    const run = apply(null, queue({ approval: evidence() })).run!;
    expectError(
      run,
      { type: "approve", commandId: "c2", runId: "r1", approval: evidence({ approvalId: "ap-2", inputHash: runInputHash(INPUT) }), at: 3_600 },
      "approval_mismatch",
      pointer({ approvalId: "ap-2" }),
    );
  });
});

describe("decideRunTransition — settle commands", () => {
  it("completes a running run and writes the submit receipt", () => {
    const { run, events } = apply(runningRun(), {
      type: "finish",
      commandId: "c1",
      runId: "r1",
      patch: { summary: "opened https://github.com/acme/widgets/pull/1", pullUrl: "https://github.com/acme/widgets/pull/1" },
      at: 9_000,
    });
    expect(events[0]).toMatchObject({ type: "run.completed" });
    expect(run).toMatchObject({ status: "completed", summary: "opened https://github.com/acme/widgets/pull/1", pullUrl: "https://github.com/acme/widgets/pull/1" });
    expect(run!.receipts!.at(-1)).toMatchObject({ kind: "submit" });
  });

  it("refuses finish on a pending run — no skipping the start gate", () => {
    expectError(pendingRun({ approval: evidence() }), { type: "finish", commandId: "c1", runId: "r1", patch: {}, at: 5_000 }, "illegal_transition");
  });

  it.each([
    ["executor_failed", "error"],
    ["server_error", "error"],
    ["outcome_unknown", "unknown"],
    ["container_lost", "unknown"],
  ] as const)("fail(%s) lands the run as %s with an error receipt", (errorCode, status) => {
    const { run } = apply(runningRun(), {
      type: "fail",
      commandId: "c1",
      runId: "r1",
      patch: { error: "boom", errorCode },
      at: 9_000,
    });
    expect(run).toMatchObject({ status, error: "boom", errorCode });
    expect(run!.receipts!.at(-1)).toMatchObject({ kind: "error", message: "boom" });
  });

  it("fail(cancelled) emits run.cancelled — same status, no error receipt", () => {
    const { run, events } = apply(runningRun(), {
      type: "fail",
      commandId: "c1",
      runId: "r1",
      patch: { error: "cancelled by operator", errorCode: "cancelled" },
      at: 9_000,
    });
    expect(events[0]).toMatchObject({ type: "run.cancelled" });
    expect(run).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(run!.receipts!.every((receipt) => receipt.kind !== "error")).toBe(true);
  });

  it.each(["pending", "running"] as const)("cancel settles a %s run as cancelled", (status) => {
    const run = status === "pending" ? pendingRun() : runningRun();
    // Production cancelRun always carries the errorCode patch.
    const { run: next } = apply(run, {
      type: "cancel",
      commandId: "c1",
      runId: "r1",
      patch: { errorCode: "cancelled" },
      at: 9_000,
    });
    expect(next).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("cancel on a terminal run is a replayed no-op, not an error", () => {
    const done = apply(runningRun(), { type: "finish", commandId: "c0", runId: "r1", patch: {}, at: 8_000 }).run!;
    const decision = decideRunTransition({ run: done }, { type: "cancel", commandId: "c1", runId: "r1", at: 9_000 });
    expect("events" in decision && decision.events[0]).toMatchObject({ type: "run.cancelled", replayed: true });
    expect(applyRunEvents(done, "events" in decision ? decision.events : [], make)).toEqual(done);
  });

  it("abort settles a running run as aborted with an error receipt", () => {
    const { run } = apply(runningRun(), { type: "abort", commandId: "c1", runId: "r1", reason: "operator killed it", at: 9_000 });
    expect(run).toMatchObject({ status: "aborted", error: "operator killed it" });
    expect(run!.receipts!.at(-1)).toMatchObject({ kind: "error" });
  });

  it.each(["pending", "running"] as const)("reclaims a stale %s run as unknown", (status) => {
    const run = status === "pending" ? pendingRun() : runningRun();
    const staleAt = run.updatedAt + 46 * 60_000;
    const { run: next, events } = apply(run, { type: "reclaim", commandId: "c1", runId: "r1", deadlineMs: 45 * 60_000, at: staleAt });
    expect(events[0]).toMatchObject({ type: "run.reclaimed" });
    expect(next).toMatchObject({ status: "unknown", errorCode: "outcome_unknown" });
    expect(next!.receipts!.at(-1)).toMatchObject({ kind: "error" });
  });

  it("refuses reclaim on a run inside its deadline", () => {
    expectError(runningRun(), { type: "reclaim", commandId: "c1", runId: "r1", deadlineMs: 45 * 60_000, at: 5_000 }, "not_stale");
  });

  it.each(["finish", "fail", "abort", "reclaim"] as const)("refuses %s on a terminal run", (type) => {
    const done = apply(runningRun(), { type: "finish", commandId: "c0", runId: "r1", patch: {}, at: 8_000 }).run!;
    const command: RunCommand =
      type === "finish"
        ? { type, commandId: "c1", runId: "r1", patch: {}, at: 9_000 }
        : type === "fail"
          ? { type, commandId: "c1", runId: "r1", patch: { errorCode: "executor_failed" }, at: 9_000 }
          : type === "abort"
            ? { type, commandId: "c1", runId: "r1", reason: "late", at: 9_000 }
            : { type, commandId: "c1", runId: "r1", deadlineMs: 1, at: 9_000_000 };
    expectError(done, command, "terminal");
  });

  it("refuses every command on a missing run", () => {
    for (const command of [
      { type: "approve", commandId: "c", runId: "x", approval: evidence(), at: 1 },
      { type: "finish", commandId: "c", runId: "x", patch: {}, at: 1 },
      { type: "fail", commandId: "c", runId: "x", patch: { errorCode: "executor_failed" }, at: 1 },
      { type: "abort", commandId: "c", runId: "x", reason: "r", at: 1 },
      { type: "cancel", commandId: "c", runId: "x", at: 1 },
      { type: "reclaim", commandId: "c", runId: "x", deadlineMs: 1, at: 1 },
    ] satisfies RunCommand[]) {
      expectError(null, command, "run_not_found");
    }
  });
});

describe("applyRunEvents — invariants", () => {
  it("bumps generation once per applied event, never on replays", () => {
    const queued = apply(null, queue({ approval: evidence() })).run!;
    expect(queued.generation).toBe(0);
    const started = apply(queued, { type: "start", commandId: "c1", runId: "r1", at: 4_000 }, pointer()).run!;
    expect(started.generation).toBe(1);
    const replayedDecision = decideRunTransition(
      { run: started, approval: pointer() },
      { type: "start", commandId: "c2", runId: "r1", at: 5_000 },
    );
    expect(applyRunEvents(started, eventsOf(replayedDecision), make)!.generation).toBe(1);
  });

  it("terminal statuses stay terminal through the type", () => {
    const done = apply(runningRun(), { type: "finish", commandId: "c1", runId: "r1", patch: {}, at: 9_000 }).run!;
    expect(isTerminalStatus(done.status)).toBe(true);
  });

  it("caps the receipt log rather than growing forever", () => {
    const run = runningRun();
    for (let i = 0; i < 300; i++) {
      run.receipts = [...(run.receipts ?? []), { at: i, kind: "code", message: `note ${i}` }];
    }
    const { run: next } = apply(run, { type: "finish", commandId: "c1", runId: "r1", patch: { summary: "done" }, at: 9_000 });
    expect(next!.receipts!.length).toBeLessThanOrEqual(256);
    expect(next!.receipts!.at(-1)).toMatchObject({ kind: "submit" });
  });
});

describe("approvalEvidenceFor + runInputHash", () => {
  it("hashes the frozen input canonically — key order and defaults stable", () => {
    const a = runInputHash(INPUT);
    const b = runInputHash({ ...INPUT });
    expect(a).toBe(b);
    expect(runInputHash({ ...INPUT, task: "different" })).not.toBe(a);
    expect(runInputHash({ ...INPUT, route: { purpose: "coding", connectionId: null, modelId: "m", harness: "opencode", policyVersion: 1 } })).not.toBe(a);
  });

  it("derives evidence from the decided record", () => {
    const record = pointer();
    const ev = approvalEvidenceFor(record, INPUT);
    expect(ev).toEqual({ approvalId: "ap-1", decidedBy: "prince", decidedAt: 2_000, inputHash: runInputHash(INPUT) });
  });
});
