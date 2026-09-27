/**
 * T41 durable command receipts: a retried or redelivered command reads
 * the receipt committed with its effect instead of re-running it.
 * Covers the /api/approvals resolve replay, the onStart re-drive of an
 * approved-but-never-minted run, queue dedupe by caller commandId, and
 * receipt-map eviction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import {
  approvalEvidenceFor,
  automationCommandId,
  MAX_COMMAND_RECEIPTS,
  putCommandReceipt,
  type CommandReceipt,
} from "../src/pending-approvals.js";
import { createRun, type DelegatedRun } from "../src/runs.js";
import { approvePointerOnly, SEED_INPUT } from "./seeding.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile(fn: () => Promise<unknown>) { return mocks.keepAliveWhile(fn); }
  schedule(...args: unknown[]) { return mocks.schedule(...args); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function agent() {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { Sandbox: {}, GITHUB_TOKEN: "test-token" }, state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) { Object.assign(this, { state }); },
  });
}

function runningRun(runId: string): DelegatedRun {
  return {
    ...createRun({
      runId, sandboxId: `sbx-${runId}`, repoUrl: "https://github.com/o/r",
      task: "t", baseBranch: "main", publishPullRequest: false,
    }),
    status: "running",
    updatedAt: Date.now(),
  };
}

const queueBody = (task: string, extra: Record<string, unknown> = {}) =>
  new Request("https://internal/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/o/r", task, ...extra }),
  });
const resolveBody = (approvalId: string, approved = true, threadKey = "default") =>
  new Request("https://internal/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey, approvalId, approved, decidedBy: "U1" }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue("ok");
});

describe("approval.resolve command receipt", () => {
  it("a retried approve dispatches exactly once and re-reads the answer", async () => {
    const instance = agent();
    const queued = await instance.onRequest(queueBody("fix"));
    const { approvalId } = (await queued.json()) as { approvalId: string };

    const first = await instance.onRequest(resolveBody(approvalId));
    expect((await first.json()) as { result: string }).toMatchObject({ result: "approved" });
    await vi.waitFor(() => { expect(mocks.execute).toHaveBeenCalledOnce(); });

    // Replay: the receipt answers with the recorded decision; no second
    // mint, no second dispatch, no re-litigation of the pointer.
    const replay = await instance.onRequest(resolveBody(approvalId));
    expect(replay.status).toBe(200);
    expect((await replay.json()) as { result: string }).toMatchObject({ result: "approved" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(instance.state.runs).toHaveLength(1);
  });

  it("a replay with the wrong threadKey re-litigates instead of reading the receipt", async () => {
    const instance = agent();
    const queued = await instance.onRequest(queueBody("fix"));
    const { approvalId } = (await queued.json()) as { approvalId: string };
    await instance.onRequest(resolveBody(approvalId));
    const replay = await instance.onRequest(resolveBody(approvalId, true, "other-thread"));
    // No receipt under this threadKey — the pointer lookup still guards.
    expect((await replay.json()) as { result: string }).toMatchObject({ result: "unknown" });
  });

  it("a refused resolve writes no receipt — a legitimate retry re-litigates", async () => {
    const instance = agent();
    const queued = await instance.onRequest(queueBody("a"));
    const { approvalId } = (await queued.json()) as { approvalId: string };
    // At-capacity refusal: the command never completed, nothing recorded.
    instance.setState({
      ...instance.state,
      runs: Array.from({ length: 5 }, (_, i) => runningRun(`r${i}`)),
    });
    const refused = await instance.onRequest(resolveBody(approvalId));
    expect(refused.status).toBe(409);
    expect(instance.state.commandReceipts?.[`approval:${approvalId}`]).toBeUndefined();

    instance.setState({ ...instance.state, runs: [] });
    const retry = await instance.onRequest(resolveBody(approvalId));
    expect((await retry.json()) as { result: string }).toMatchObject({ result: "approved" });
  });

  it("the replayed resolve leaves the run record byte-identical", async () => {
    const instance = agent();
    const queued = await instance.onRequest(queueBody("fix"));
    const { approvalId } = (await queued.json()) as { approvalId: string };
    await instance.onRequest(resolveBody(approvalId));
    await vi.waitFor(() => { expect(mocks.execute).toHaveBeenCalledOnce(); });
    const before = JSON.stringify(instance.state.runs);
    await instance.onRequest(resolveBody(approvalId));
    expect(JSON.stringify(instance.state.runs)).toBe(before);
  });
});

describe("onStart re-drive of approved-but-never-minted runs", () => {
  it("mints and dispatches the run exactly once", async () => {
    const instance = agent();
    // The resolve committed the pointer but died before the run mint —
    // no run, no receipt. Exactly the gap §18.0 found.
    approvePointerOnly(instance, "ap-lost", SEED_INPUT);
    await instance.onStart();
    await vi.waitFor(() => { expect(mocks.execute).toHaveBeenCalledOnce(); });
    const run = instance.state.runs.find((r) => r.runId === "agent-tool:ap-lost");
    expect(run).toBeDefined();
    expect(instance.state.commandReceipts?.["approval:ap-lost"]?.dispatched).toBe(true);

    // A second restart does not re-drive: the receipt records the
    // command as completed even though no terminal state landed.
    const restarted = agent();
    restarted.setState(structuredClone(instance.state));
    await restarted.onStart();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("does not re-drive when the run record already landed", async () => {
    const instance = agent();
    approvePointerOnly(instance, "ap-landed", SEED_INPUT);
    // Simulate "dispatch ran then the DO died": run exists but its
    // command receipt was never written (pre-T41 state).
    const record = instance.state.pendingApprovals!.find((a) => a.approvalId === "ap-landed")!;
    const frozen = { repoUrl: record.repoUrl, task: record.task, baseBranch: "main", publishPullRequest: false };
    instance.setState({
      ...instance.state,
      runs: [...instance.state.runs, createRun({
        runId: "agent-tool:ap-landed", sandboxId: "sbx-ap-landed", ...frozen,
        approval: approvalEvidenceFor(record, frozen),
      })],
    });
    await instance.onStart();
    // Interrupt pass stamped the pending run unknown; the receipt just
    // records the command as completed — no second execute.
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(instance.state.runs.find((r) => r.runId === "agent-tool:ap-landed")?.status).toBe("unknown");
    expect(instance.state.commandReceipts?.["approval:ap-landed"]?.dispatched).toBe(true);
  });
});

describe("run.queue command receipt", () => {
  it("a redelivered queue mints a single approval", async () => {
    const instance = agent();
    const commandId = "automation:aut-1:gh:delivery-42";
    const first = await instance.onRequest(queueBody("fix", { commandId }));
    const second = await instance.onRequest(queueBody("fix", { commandId }));
    const a = (await first.json()) as { approvalId: string };
    const b = (await second.json()) as { approvalId: string; deduped?: boolean };
    expect(a.approvalId).toBe(b.approvalId);
    expect(b.deduped).toBe(true);
    expect(instance.state.pendingApprovals).toHaveLength(1);
  });

  it("queues without a commandId behave exactly as before", async () => {
    const instance = agent();
    const first = await instance.onRequest(queueBody("fix"));
    const second = await instance.onRequest(queueBody("fix"));
    const a = (await first.json()) as { approvalId: string };
    const b = (await second.json()) as { approvalId: string };
    expect(a.approvalId).not.toBe(b.approvalId);
    expect(instance.state.pendingApprovals).toHaveLength(2);
  });
});

describe("automationCommandId", () => {
  it("is deterministic per automation + event identity", () => {
    expect(automationCommandId("a1", { kind: "github", deliveryId: "d1" }))
      .toBe("automation:a1:gh:d1");
    expect(automationCommandId("a1", { kind: "slack", eventId: "Ev1" }))
      .toBe("automation:a1:slack:Ev1");
    const tick = automationCommandId("a1", { kind: "schedule", nowMs: 1_700_000_000_000 });
    expect(tick).toBe(automationCommandId("a1", { kind: "schedule", nowMs: 1_700_000_000_000 + 30_000 }));
    expect(automationCommandId("a1", { kind: "webhook" })).toBeUndefined();
    expect(automationCommandId("a1", { kind: "manual" })).toBeUndefined();
    // Fingerprint fallback: same mapped event, same command id.
    const fp = automationCommandId("a1", { kind: "github", event: "push", repo: "o/r" });
    expect(fp).toBe(automationCommandId("a1", { kind: "github", event: "push", repo: "o/r" }));
    expect(fp).toContain(":gh:fp:");
  });
});

describe("putCommandReceipt eviction", () => {
  it("caps the map at MAX_COMMAND_RECEIPTS, evicting oldest first", () => {
    let map: Record<string, CommandReceipt> = {};
    for (let i = 0; i < MAX_COMMAND_RECEIPTS + 10; i++) {
      map = putCommandReceipt(map, { commandId: `c${i}`, kind: "run.queue", outcome: "queued", at: i });
    }
    expect(Object.keys(map)).toHaveLength(MAX_COMMAND_RECEIPTS);
    expect(map["c0"]).toBeUndefined();
    expect(map[`c${MAX_COMMAND_RECEIPTS + 9}`]).toBeDefined();
  });
});
