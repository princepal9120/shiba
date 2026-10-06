/**
 * POST /api/runs/<id>/fork (PLAN-V2-NEXT): mint a sibling run from a
 * parent checkpoint. The fork is approval-gated like every minted run;
 * lineage rides the frozen input so the record, the approval card, and
 * the input hash all carry it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import type { SpineEvent } from "@shiba/shared";
import {
  applyRunEvents,
  applySpineEvent,
  decideRunTransition,
  runInputHash,
  type QueuedRunInput,
  type Receipt,
  type ReceiptKind,
} from "@shiba/shared";
import { createRun } from "../src/runs.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
  postSlackMessage: vi.fn(async () => ({})),
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
vi.mock("../src/slack.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/slack.js")>()),
  postSlackMessage: mocks.postSlackMessage,
}));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const AGENT_PRINCIPAL_HEADER = "X-Agent-Principal";
const CP0 = "refs/shiba/checkpoints/sbx-parent/0";
const CP1 = "refs/shiba/checkpoints/sbx-parent/1";

function agent() {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: {}, GITHUB_TOKEN: "test-token" },
    name: "dashboard:test",
    ctx: { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) },
    state: { runs: [] } as OrchestratorState,
    setState(this: CodingOrchestrator, next: OrchestratorState) {
      setStateLikeProduction(this, next);
    },
  });
}

const forkBody = (parentRunId: string, body: Record<string, unknown> = {}, principal?: string) =>
  new Request(`https://internal/api/runs/${encodeURIComponent(parentRunId)}/fork`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(principal ? { [AGENT_PRINCIPAL_HEADER]: principal } : {}),
    },
    body: JSON.stringify(body),
  });

const resolveBody = (approvalId: string) =>
  new Request("https://internal/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
  });

/** Mint a real run on the host, then stamp checkpoint signals onto it. */
async function seedParent(instance: CodingOrchestrator, withCheckpoints: boolean) {
  const run = createRun({
    runId: "run-parent",
    sandboxId: "sbx-parent",
    repoUrl: "https://github.com/o/r",
    task: "parent task",
    baseBranch: "main",
    publishPullRequest: true,
  });
  const parent = {
    ...run,
    ...(withCheckpoints
      ? {
          signals: [
            { kind: "checkpoint.captured" as const, at: 1, detail: CP0 },
            { kind: "checkpoint.captured" as const, at: 2, detail: CP1 },
          ],
        }
      : {}),
  };
  instance.state.runs = [parent];
  return parent;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue("ok");
  mocks.postSlackMessage.mockResolvedValue({});
});

const make = (kind: ReceiptKind, message: string, at: number): Receipt => ({ at, kind, message });

describe("decider: forkedFrom rides the frozen input", () => {
  const base: QueuedRunInput = {
    sandboxId: "sbx",
    repoUrl: "https://github.com/o/r",
    task: "t",
    baseBranch: "main",
    publishPullRequest: false,
    forkedFrom: { runId: "run-a", checkpointRef: CP0 },
  };

  it("mints the lineage onto the record and covers it in the hash", () => {
    const decision = decideRunTransition(
      { run: null, approval: null },
      { type: "queue", commandId: "c1", runId: "run-f", input: base, at: 1 },
    );
    expect("error" in decision).toBe(false);
    if ("error" in decision) return;
    const run = applyRunEvents(null, decision.events, make);
    expect(run?.forkedFrom).toEqual({ runId: "run-a", checkpointRef: CP0 });
    // The hash covers lineage: same input, different lineage → different hash.
    expect(runInputHash({ ...base, forkedFrom: { runId: "run-a", checkpointRef: CP0 } })).not.toBe(
      runInputHash({ ...base, forkedFrom: undefined }),
    );
  });

  it("a replay with different lineage is not the same input", () => {
    const decision = decideRunTransition(
      { run: null, approval: null },
      { type: "queue", commandId: "c1", runId: "run-f", input: base, at: 1 },
    );
    if ("error" in decision) throw new Error("expected mint");
    const run = applyRunEvents(null, decision.events, make);
    const replay = decideRunTransition(
      { run, approval: null },
      {
        type: "queue",
        commandId: "c1",
        runId: "run-f",
        input: { ...base, forkedFrom: { runId: "run-b", checkpointRef: CP0 } },
        at: 2,
      },
    );
    expect("error" in replay ? replay.error.message : "ok").toMatch(/input/i);
  });
});

describe("POST /api/runs/<id>/fork", () => {
  it("404s when the parent run is missing", async () => {
    const instance = agent();
    const res = await instance.onRequest(forkBody("run-nope"));
    expect(res.status).toBe(404);
  });

  it("400s when the parent never captured a checkpoint", async () => {
    const instance = agent();
    await seedParent(instance, false);
    const res = await instance.onRequest(forkBody("run-parent"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/checkpoint/i);
  });

  it("mints an approval carrying the parent's frozen input + lineage", async () => {
    const instance = agent();
    const parent = await seedParent(instance, true);
    const res = await instance.onRequest(forkBody("run-parent"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      approvalId: string;
      forkedFrom: { runId: string; checkpointRef: string };
    };
    expect(body.ok).toBe(true);
    // Default checkpoint = the parent's latest capture.
    expect(body.forkedFrom).toEqual({ runId: "run-parent", checkpointRef: CP1 });

    const approval = instance.state.pendingApprovals?.find((a) => a.approvalId === body.approvalId);
    expect(approval).toBeDefined();
    expect(approval?.forkedFrom).toEqual(body.forkedFrom);
    expect(approval?.task).toBe(parent.task);
    expect(approval?.repoUrl).toBe(parent.repoUrl);
    // The parent record is untouched — no mutations, no signals added.
    expect(instance.state.runs.find((r) => r.runId === "run-parent")?.signals).toHaveLength(2);
    // The spine saw the fork.
    const forked = (instance.state.events ?? []).filter((e) => e.kind === "run.forked");
    expect(forked).toHaveLength(1);
    expect((forked[0]!.payload as { forkedFrom: unknown }).forkedFrom).toEqual(body.forkedFrom);

    // Approving mints the sibling run with lineage on the record.
    const resolved = await instance.onRequest(resolveBody(body.approvalId));
    expect(resolved.status).toBe(200);
    const child = instance.state.runs.find((r) => r.runId !== "run-parent");
    expect(child).toBeDefined();
    expect(child?.forkedFrom).toEqual(body.forkedFrom);
    expect(child?.task).toBe(parent.task);
  });

  it("targets a named checkpoint by seq and swaps the task on prompt", async () => {
    const instance = agent();
    await seedParent(instance, true);
    const res = await instance.onRequest(
      forkBody("run-parent", { checkpoint: 0, prompt: "redo it differently" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      approvalId: string;
      forkedFrom: { checkpointRef: string };
    };
    expect(body.forkedFrom.checkpointRef).toBe(CP0);
    const approval = instance.state.pendingApprovals?.find((a) => a.approvalId === body.approvalId);
    expect(approval?.task).toBe("redo it differently");
  });

  it("rejects a checkpoint the parent never captured", async () => {
    const instance = agent();
    await seedParent(instance, true);
    expect((await instance.onRequest(forkBody("run-parent", { checkpoint: 9 }))).status).toBe(400);
    expect(
      (await instance.onRequest(forkBody("run-parent", { checkpoint: "refs/other/ref" }))).status,
    ).toBe(400);
  });

  it("hides another principal's run from agent principals", async () => {
    const instance = agent();
    const parent = await seedParent(instance, true);
    instance.state.runs = [{ ...parent, queuedBy: "agent-alpha" }];
    const res = await instance.onRequest(forkBody("run-parent", {}, "agent-beta"));
    expect(res.status).toBe(404);
    // Its own run is visible and queues under its own name.
    const mine = await instance.onRequest(forkBody("run-parent", {}, "agent-alpha"));
    expect(mine.status).toBe(200);
    const { approvalId } = (await mine.json()) as { approvalId: string };
    expect(
      instance.state.pendingApprovals?.find((a) => a.approvalId === approvalId)?.queuedBy,
    ).toBe("agent-alpha");
  });

  it("dedupes a retried fork on commandId", async () => {
    const instance = agent();
    await seedParent(instance, true);
    const first = await instance.onRequest(forkBody("run-parent", { commandId: "f-1" }));
    const { approvalId } = (await first.json()) as { approvalId: string };
    const second = await instance.onRequest(forkBody("run-parent", { commandId: "f-1" }));
    const secondBody = (await second.json()) as { approvalId: string; deduped?: boolean };
    expect(secondBody.approvalId).toBe(approvalId);
    expect(secondBody.deduped).toBe(true);
    expect(instance.state.pendingApprovals).toHaveLength(1);
  });

  it("exposes lineage on the run record after approve", async () => {
    const instance = agent();
    await seedParent(instance, true);
    const res = await instance.onRequest(forkBody("run-parent"));
    const { approvalId } = (await res.json()) as { approvalId: string };
    await instance.onRequest(resolveBody(approvalId));
    const listed = (await (
      await instance.onRequest(new Request("https://internal/api/runs"))
    ).json()) as { runs: Array<{ runId: string; forkedFrom?: { runId: string } }> };
    const child = listed.runs.find((r) => r.runId !== "run-parent");
    expect(child?.forkedFrom?.runId).toBe("run-parent");
  });
});

describe("spine: run.forked", () => {
  it("projects as a log-only event (no run fold)", () => {
    const event = {
      seq: 1,
      kind: "run.forked" as const,
      commandId: "fork:x",
      runId: "run-parent",
      at: 1,
      payload: { forkedFrom: { runId: "run-parent", checkpointRef: CP0 } },
    } satisfies SpineEvent;
    const state = { runs: [], events: [], outbox: [] } as unknown as Parameters<
      typeof applySpineEvent
    >[0];
    const next = applySpineEvent(state, event, make);
    expect(next.events).toHaveLength(1);
    expect(next.runs).toHaveLength(0);
  });
});
