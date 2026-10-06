/**
 * PLAN-V2-NEXT P9 — the event spine: schema-validated append log,
 * pure projector, and effect outbox. No Worker runtime, no DO — the
 * same purity proof decide.test.ts gives the decider: the log, the
 * fold, and the drainer are exercised against plain objects.
 */

import {
  applyRunEvents,
  applySpineEvent,
  approvalEventInput,
  decideRunTransition,
  foldOutboxEvent,
  MAX_SPINE_EVENTS,
  OUTBOX_DISPATCHED_KEEP,
  OUTBOX_FAILED_KEEP,
  type OutboxEntry,
  type PendingApproval,
  type QueuedRunInput,
  type Receipt,
  type ReceiptKind,
  replaySpine,
  runInputHash,
  type SpineEvent,
  type SpineEventInput,
  type SpineProjection,
  sideEffectRequestInput,
  sideEffectResultInput,
  spineInputsFromDecider,
} from "@shiba/shared";
import { describe, expect, it } from "vitest";
import { appendBatch, nextSeq } from "../src/orchestration/event-log.js";
import {
  drainOutbox,
  dueEntries,
  exhaustedEntries,
  MAX_OUTBOX_ATTEMPTS,
} from "../src/orchestration/outbox.js";

const make = (kind: ReceiptKind, message: string, at: number): Receipt => ({ at, kind, message });

const INPUT: QueuedRunInput = {
  sandboxId: "sbx-1",
  repoUrl: "https://github.com/acme/widgets",
  task: "Add a widget",
  baseBranch: "main",
  publishPullRequest: false,
};

function appendAll(log: SpineEvent[], inputs: SpineEventInput[]): SpineEvent[] {
  return [...log, ...appendBatch(log, inputs)];
}

describe("appendBatch — the DO log", () => {
  it("assigns a per-orchestrator seq continuing from the retained tail", () => {
    const first = appendBatch([], [{ kind: "run.started", commandId: "c1", runId: "r1", at: 1 }]);
    expect(first[0]!.seq).toBe(1);
    const second = appendBatch(first, [
      { kind: "run.completed", commandId: "c2", runId: "r1", at: 2 },
      {
        kind: "side_effect.requested",
        commandId: "c3",
        at: 3,
        payload: { effectId: "fx:1", effectKind: "slack.post", target: "slack:C:T" },
      },
    ]);
    expect(second.map((e) => e.seq)).toEqual([2, 3]);
    expect(nextSeq([...first, ...second])).toBe(4);
  });

  it("rejects malformed events — a bad append aborts the write", () => {
    expect(() =>
      appendBatch([], [{ kind: "not.a.kind" as never, commandId: "c1", at: 1 }]),
    ).toThrow();
    expect(() =>
      appendBatch([], [{ kind: "run.started", commandId: "", at: 1 } as never]),
    ).toThrow();
  });
});

describe("spineInputsFromDecider — decider → spine mapping", () => {
  it("maps run.queued to run.proposed carrying the minted record", () => {
    const decision = decideRunTransition(
      { run: null },
      { type: "queue", commandId: "queue:r1", runId: "r1", input: INPUT, at: 1_000 },
    );
    expect("error" in decision).toBe(false);
    if ("error" in decision) return;
    const inputs = spineInputsFromDecider("r1", "queue:r1", decision.events, 1_000);
    expect(inputs.map((i) => i.kind)).toEqual(["run.proposed"]);
    expect(inputs[0]!.payload).toMatchObject({ run: { runId: "r1" } });
  });

  it("maps aborted and reclaimed to run.failed without inventing new kinds", () => {
    for (const t of ["run.aborted", "run.reclaimed"] as const) {
      const inputs = spineInputsFromDecider(
        "r1",
        "c",
        [{ type: t, commandId: "c", at: 1, patch: {} } as never],
        1,
      );
      expect(inputs[0]!.kind).toBe("run.failed");
    }
  });
});

describe("applySpineEvent / replaySpine — the projection", () => {
  const approval: PendingApproval = {
    threadKey: "default",
    approvalId: "ap-1",
    repoUrl: INPUT.repoUrl,
    task: INPUT.task,
    status: "pending",
    createdAt: 1_000,
  };

  it("run.proposed mints the row; replay walks the real lifecycle to completed", () => {
    const evidence = {
      approvalId: "ap-1",
      decidedBy: "prince",
      decidedAt: 900,
      inputHash: runInputHash(INPUT),
    };
    const inputs: SpineEventInput[][] = [];
    let run = null;
    for (const command of [
      {
        type: "queue",
        commandId: "queue:r1",
        runId: "r1",
        input: INPUT,
        approval: evidence,
        at: 1_000,
      },
      { type: "start", commandId: "start:r1", runId: "r1", at: 1_500 },
      {
        type: "finish",
        commandId: "finish:r1",
        runId: "r1",
        patch: { summary: "done" },
        at: 2_000,
      },
    ] as const) {
      const decision = decideRunTransition({ run, approval: null }, command as never);
      if ("error" in decision)
        throw new Error(`${command.type} rejected: ${decision.error.message}`);
      inputs.push(spineInputsFromDecider("r1", command.commandId, decision.events, command.at));
      run = applyRunEvents(run, decision.events, make);
    }
    const log = appendAll([], inputs.flat());
    expect(log.map((e) => e.kind)).toEqual(["run.proposed", "run.started", "run.completed"]);
    const state: SpineProjection = replaySpine({ runs: [] }, log, make);
    expect(state.runs).toHaveLength(1);
    // The replayed projection must equal the row the live decider produced.
    expect(state.runs[0]).toEqual(run);
    expect(state.runs[0]!.status).toBe("completed");
    expect(state.events).toHaveLength(log.length);
  });

  it("side_effect.requested opens an outbox row; dispatched settles it", () => {
    const request = sideEffectRequestInput({
      effectId: "fx:slack.post:c1",
      effectKind: "slack.post",
      target: "slack:C1:T1",
      summary: "Run finished",
      commandId: "c1",
      runId: "r1",
      at: 1_000,
    });
    const result: SpineEventInput = {
      kind: "side_effect.dispatched",
      commandId: "post:fx:slack.post:c1",
      causationId: "seq:1",
      at: 1_500,
      payload: { effectId: "fx:slack.post:c1", effectKind: "slack.post", target: "slack:C1:T1" },
    };
    const log = appendAll([], [request, result]);
    const state: SpineProjection = replaySpine({ runs: [] }, log, make);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox![0]!).toMatchObject({
      id: "fx:slack.post:c1",
      status: "dispatched",
      attempts: 1,
      runId: "r1",
    });
  });

  it("approval.requested and approval.answered move the pointer", () => {
    const inputs = [
      approvalEventInput({ approval, commandId: "q:ap-1", at: 1_000 }),
      approvalEventInput({
        approval: { ...approval, status: "approved", decidedBy: "prince", decidedAt: 2_000 },
        result: "approved",
        commandId: "approval:ap-1",
        at: 2_000,
      }),
    ];
    const state: SpineProjection = replaySpine({ runs: [] }, appendBatch([], inputs), make);
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals![0]!.status).toBe("approved");
  });

  it("appendToLog retention caps the tail", () => {
    let state: SpineProjection = { runs: [] };
    for (let i = 0; i < MAX_SPINE_EVENTS + 5; i++) {
      const [event] = appendBatch(state.events, [
        { kind: "run.progress", commandId: `c${i}`, runId: "r1", at: i },
      ]);
      state = applySpineEvent(state, event!, make);
    }
    expect(state.events).toHaveLength(MAX_SPINE_EVENTS);
    expect(state.events![0]!.seq).toBe(6);
  });
});

describe("drainOutbox — the effect drainer", () => {
  it("executes pending entries, skips settled ones, records failures", async () => {
    const outbox = [
      {
        id: "fx:a",
        effectKind: "slack.post",
        target: "slack:C:T",
        status: "pending" as const,
        attempts: 0,
        requestedAt: 1,
      },
      {
        id: "fx:b",
        effectKind: "chat.post",
        target: "chat:x",
        status: "dispatched" as const,
        attempts: 1,
        requestedAt: 1,
      },
      {
        id: "fx:c",
        effectKind: "slack.post",
        target: "slack:C:T",
        status: "failed" as const,
        attempts: 1,
        requestedAt: 1,
      },
      {
        id: "fx:d",
        effectKind: "slack.post",
        target: "slack:C:T",
        status: "failed" as const,
        attempts: MAX_OUTBOX_ATTEMPTS,
        requestedAt: 1,
      },
    ];
    const executed: string[] = [];
    const results = await drainOutbox(outbox, async (entry) => {
      executed.push(entry.id);
      return entry.id === "fx:c" ? { ok: false, error: "still down" } : { ok: true };
    });
    expect(executed).toEqual(["fx:a", "fx:c"]);
    expect(dueEntries(outbox).map((e) => e.id)).toEqual(["fx:a", "fx:c", "fx:d"]);
    expect(results).toEqual([
      { entry: outbox[0], ok: true },
      { entry: outbox[2], ok: false, error: "still down" },
    ]);
  });

  it("a throwing executor lands as a failure result, never an exception", async () => {
    const outbox = [
      {
        id: "fx:x",
        effectKind: "slack.post",
        target: "t",
        status: "pending" as const,
        attempts: 0,
        requestedAt: 1,
      },
    ];
    const results = await drainOutbox(outbox, async () => {
      throw new Error("network gone");
    });
    expect(results).toEqual([{ entry: outbox[0], ok: false, error: "network gone" }]);
  });
});

describe("outbox retention — settled rows prune, owed rows never do", () => {
  const request = (id: string, at: number): SpineEventInput =>
    sideEffectRequestInput({
      effectId: id,
      effectKind: "slack.post",
      target: "slack:C:T",
      commandId: `post:${id}`,
      at,
    });
  const result = (id: string, ok: boolean, at: number): SpineEventInput =>
    sideEffectResultInput({
      effectId: id,
      effectKind: "slack.post",
      target: "slack:C:T",
      ok,
      ...(ok ? {} : { error: "boom" }),
      commandId: `drain:${id}`,
      at,
    });
  const foldAll = (inputs: SpineEventInput[]): OutboxEntry[] =>
    appendBatch([], inputs).reduce<OutboxEntry[] | undefined>(
      (outbox, event) => foldOutboxEvent(outbox, event),
      undefined,
    )!;

  it("dispatched rows keep a bounded newest tail", () => {
    const inputs: SpineEventInput[] = [];
    for (let i = 0; i < OUTBOX_DISPATCHED_KEEP + 10; i += 1) {
      inputs.push(request(`fx:${i}`, i + 1), result(`fx:${i}`, true, i + 1));
    }
    const outbox = foldAll(inputs);
    expect(outbox).toHaveLength(OUTBOX_DISPATCHED_KEEP);
    expect(outbox.every((e) => e.status === "dispatched")).toBe(true);
    // The newest tail survives; the oldest settled rows are pruned.
    expect(outbox[0]!.id).toBe("fx:10");
    expect(outbox[outbox.length - 1]!.id).toBe(`fx:${OUTBOX_DISPATCHED_KEEP + 9}`);
  });

  it("rows the drainer still owes are never pruned", () => {
    const inputs: SpineEventInput[] = [];
    // Saturate the settled tails first.
    for (let i = 0; i < OUTBOX_DISPATCHED_KEEP + 10; i += 1) {
      inputs.push(request(`ok:${i}`, i + 1), result(`ok:${i}`, true, i + 1));
    }
    for (let i = 0; i < OUTBOX_FAILED_KEEP + 10; i += 1) {
      inputs.push(request(`dead:${i}`, i + 1));
      for (let n = 0; n < MAX_OUTBOX_ATTEMPTS; n += 1) {
        inputs.push(result(`dead:${i}`, false, i + 1));
      }
    }
    // A pending row and a still-retryable failure ride at the end.
    inputs.push(request("fx:pending", 500), request("fx:retry", 501), result("fx:retry", false, 502));
    const outbox = foldAll(inputs);
    const ids = outbox.map((e) => e.id);
    expect(ids).toContain("fx:pending");
    expect(ids).toContain("fx:retry");
    // Nothing the drainer could still execute was dropped: due =
    // pending|failed minus the attempts cap drainOutbox enforces.
    const executable = dueEntries(outbox).filter((e) => e.attempts < MAX_OUTBOX_ATTEMPTS);
    expect(executable.map((e) => e.id)).toEqual(["fx:pending", "fx:retry"]);
    // The exhausted tail survived bounded — dead rows still inspectable.
    expect(exhaustedEntries(outbox)).toHaveLength(OUTBOX_FAILED_KEEP);
  });

  it("exhausted failures keep a bounded triage tail", () => {
    const inputs: SpineEventInput[] = [];
    for (let i = 0; i < OUTBOX_FAILED_KEEP + 10; i += 1) {
      inputs.push(request(`dead:${i}`, i + 1));
      for (let n = 0; n < MAX_OUTBOX_ATTEMPTS; n += 1) {
        inputs.push(result(`dead:${i}`, false, i + 1));
      }
    }
    const outbox = foldAll(inputs);
    expect(outbox).toHaveLength(OUTBOX_FAILED_KEEP);
    expect(exhaustedEntries(outbox)).toHaveLength(OUTBOX_FAILED_KEEP);
    // The newest failures stay inspectable; the oldest are gone.
    expect(outbox[0]!.id).toBe("dead:10");
    expect(outbox[outbox.length - 1]!.id).toBe(`dead:${OUTBOX_FAILED_KEEP + 9}`);
  });
});
