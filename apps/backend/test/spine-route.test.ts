/**
 * GET /api/spine — the dashboard's window onto the orchestrator's event log.
 * Dashboard principals see the full spine; agent principals see only events
 * and outbox entries on runs they queued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import type { SpineEvent, OutboxEntry } from "@shiba/shared";
import { createRun, transitionRun } from "../src/runs.js";
import { evidenceFor } from "./seeding.js";
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
// Thread post-backs never hit the network in unit tests — the outbox row is
// what matters, not the delivery.
vi.mock("../src/slack.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/slack.js")>()),
  postSlackMessage: mocks.postSlackMessage,
}));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const AGENT_PRINCIPAL_HEADER = "X-Agent-Principal";

function agent(threadName?: string) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { ...productionEnvStubs(), Sandbox: {}, GITHUB_TOKEN: "test-token", SLACK_BOT_TOKEN: "xoxb-test" },
    name: threadName,
    ctx: { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined) },
    state: { runs: [] } as OrchestratorState,
    // The test subclass shadows the P9 setState override — the shared
    // host drives the real flush in production order: apply → commit → drain.
    setState(this: CodingOrchestrator, next: OrchestratorState) {
      setStateLikeProduction(this, next);
    },
  });
}

const queueBody = (task: string, queuedBy?: string) =>
  new Request("https://internal/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(queuedBy ? { [AGENT_PRINCIPAL_HEADER]: queuedBy } : {}),
    },
    body: JSON.stringify({ repoUrl: "https://github.com/o/r", task }),
  });

const spineGet = (principal?: string) =>
  new Request("https://internal/api/spine", {
    headers: principal ? { [AGENT_PRINCIPAL_HEADER]: principal } : {},
  });

const resolveBody = (approvalId: string, approved = true) =>
  new Request("https://internal/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: "default", approvalId, approved, decidedBy: "U1" }),
  });

/** Let a fire-and-forget waitUntil chain settle (microtask drain). */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue("ok");
  mocks.postSlackMessage.mockResolvedValue({});
});

describe("GET /api/spine", () => {
  it("records the queue, then the mint when the approval resolves", async () => {
    const instance = agent();
    const queued = await instance.onRequest(queueBody("fix"));
    expect(queued.status).toBe(200);
    const { approvalId } = (await queued.json()) as { approvalId: string };

    const before = (await (await instance.onRequest(spineGet())).json()) as {
      events: SpineEvent[];
      outbox: OutboxEntry[];
    };
    // Queueing only asks for approval — the run exists on mint.
    expect(before.events.map((e) => e.kind)).toContain("approval.requested");
    expect(before.events[0]!.seq).toBe(1);
    expect(Array.isArray(before.outbox)).toBe(true);

    const resolved = await instance.onRequest(resolveBody(approvalId));
    expect(resolved.status).toBe(200);
    const after = (await (await instance.onRequest(spineGet())).json()) as {
      events: SpineEvent[];
      outbox: OutboxEntry[];
    };
    expect(after.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["approval.answered", "run.proposed"]),
    );
    // seq is monotonic across commits — no reuse, no reset.
    expect(after.events.map((e) => e.seq)).toEqual(
      [...after.events].map((_, i) => i + 1),
    );
    const proposed = after.events.find((e) => e.kind === "run.proposed");
    expect(proposed?.runId).toBe(`agent-tool:${approvalId}`);
  });

  it("an agent principal sees only events on its own runs", async () => {
    const instance = agent("slack:T1:C1:111.222");
    const mine = await instance.onRequest(queueBody("mine", "agent-alpha"));
    const { approvalId: mineApproval } = (await mine.json()) as { approvalId: string };
    const theirs = await instance.onRequest(queueBody("theirs"));
    const { approvalId: theirsApproval } = (await theirs.json()) as { approvalId: string };
    await instance.onRequest(resolveBody(mineApproval));
    await instance.onRequest(resolveBody(theirsApproval));

    const response = await instance.onRequest(spineGet("agent-alpha"));
    const body = (await response.json()) as { events: SpineEvent[]; outbox: OutboxEntry[] };
    const mineRun = `agent-tool:${mineApproval}`;
    const theirsRun = `agent-tool:${theirsApproval}`;
    // Alpha's own run events are visible; the other run's and any
    // runId-less orchestrator-internal events stay hidden.
    expect(body.events.some((e) => e.runId === mineRun)).toBe(true);
    expect(body.events.every((e) => e.runId === mineRun)).toBe(true);
    expect(body.events.some((e) => e.runId === theirsRun)).toBe(false);
    expect(body.outbox.every((e) => e.runId === mineRun)).toBe(true);
  });

  it("filters outbox rows to the principal's runs — not vacuously", async () => {
    const instance = agent("slack:T1:C1:111.222");
    const mine = await instance.onRequest(queueBody("mine", "agent-alpha"));
    const { approvalId: mineApproval } = (await mine.json()) as { approvalId: string };
    const theirs = await instance.onRequest(queueBody("theirs"));
    const { approvalId: theirsApproval } = (await theirs.json()) as { approvalId: string };
    await instance.onRequest(resolveBody(mineApproval));
    await instance.onRequest(resolveBody(theirsApproval));
    const mineRun = `agent-tool:${mineApproval}`;
    const theirsRun = `agent-tool:${theirsApproval}`;

    // Populate the outbox: a run completion posts back to the thread,
    // which requests a slack.post side effect tagged with that runId.
    type ThreadInternals = {
      postToThread(text: string, context?: { runId?: string; causationId?: string }): void;
    };
    const threaded = instance as unknown as ThreadInternals;
    threaded.postToThread("mine finished", { runId: mineRun });
    threaded.postToThread("theirs finished", { runId: theirsRun });

    // Full view: both runs' effects are owed.
    const all = (await (await instance.onRequest(spineGet())).json()) as { outbox: OutboxEntry[] };
    expect(all.outbox.filter((e) => e.runId === mineRun)).toHaveLength(1);
    expect(all.outbox.filter((e) => e.runId === theirsRun)).toHaveLength(1);

    // Agent view: only its own run's effects — the previous assertion was
    // vacuous while the outbox stayed empty.
    const scoped = (await (await instance.onRequest(spineGet("agent-alpha"))).json()) as {
      outbox: OutboxEntry[];
    };
    expect(scoped.outbox.length).toBeGreaterThan(0);
    expect(scoped.outbox.every((e) => e.runId === mineRun)).toBe(true);
    expect(scoped.outbox.some((e) => e.runId === theirsRun)).toBe(false);
  });

  it("rejects non-GET methods", async () => {
    const instance = agent();
    const response = await instance.onRequest(
      new Request("https://internal/api/spine", { method: "POST" }),
    );
    expect(response.status).toBe(405);
  });

  it("?since=<seq> returns only newer events plus the log-window markers", async () => {
    const instance = agent();
    const queued = await instance.onRequest(queueBody("fix"));
    const { approvalId } = (await queued.json()) as { approvalId: string };
    await instance.onRequest(resolveBody(approvalId));

    const full = (await (await instance.onRequest(spineGet())).json()) as {
      events: SpineEvent[];
      earliestSeq: number;
      latestSeq: number;
      totalEvents: number;
    };
    expect(full.earliestSeq).toBe(1);
    expect(full.latestSeq).toBe(full.events[full.events.length - 1]!.seq);
    expect(full.totalEvents).toBe(full.events.length);

    const cut = full.events[1]!.seq;
    const tail = (await (
      await instance.onRequest(new Request(`https://internal/api/spine?since=${cut}`))
    ).json()) as { events: SpineEvent[]; earliestSeq: number; latestSeq: number };
    expect(tail.events.every((e) => e.seq > cut)).toBe(true);
    expect(tail.events[0]!.seq).toBe(cut + 1);
    // The window markers describe the whole log — the dispatch working in
    // the background may have appended between the two fetches.
    expect(tail.earliestSeq).toBe(full.earliestSeq);
    expect(tail.latestSeq).toBeGreaterThanOrEqual(full.latestSeq);
    expect(tail.events.map((e) => e.seq)).toEqual(
      expect.arrayContaining(full.events.filter((e) => e.seq > cut).map((e) => e.seq)),
    );

    for (const bad of ["-1", "1.5", "abc"]) {
      const response = await instance.onRequest(
        new Request(`https://internal/api/spine?since=${bad}`),
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("outbox in-flight claims", () => {
  it("the drainer skips a row whose send is still open, and retries it honestly after failure", async () => {
    const instance = agent("slack:T1:C1:111.222");
    type ThreadInternals = {
      postToThread(text: string, context?: { runId?: string }): void;
      reclaimRuns(): Promise<void>;
    };
    const threaded = instance as unknown as ThreadInternals;

    // Hold the send open: the row commits pending while the send runs.
    let release!: () => void;
    const open = new Promise<Record<string, never>>((resolve) => {
      release = () => resolve({});
    });
    mocks.postSlackMessage.mockImplementationOnce(() => open);
    threaded.postToThread("hi", { runId: "r1" });
    expect(instance.state.outbox?.[0]?.status).toBe("pending");

    // A read-path reclaim mid-send must not re-drive the open send.
    await threaded.reclaimRuns();
    expect(mocks.postSlackMessage).toHaveBeenCalledTimes(1);

    // Resolve the send — the row settles dispatched, still one call.
    release();
    await flush();
    expect(instance.state.outbox?.[0]?.status).toBe("dispatched");
    await threaded.reclaimRuns();
    expect(mocks.postSlackMessage).toHaveBeenCalledTimes(1);

    // A send that fails retries on the next drain — at-least-once intact.
    mocks.postSlackMessage.mockRejectedValueOnce(new Error("slack down"));
    threaded.postToThread("hi again", { runId: "r1" });
    await flush();
    expect(instance.state.outbox?.[1]?.status).toBe("failed");
    await threaded.reclaimRuns();
    expect(mocks.postSlackMessage).toHaveBeenCalledTimes(3);
    expect(instance.state.outbox?.[1]?.status).toBe("dispatched");
  });
});

describe("GET /api/runs reclaim floor", () => {
  it("floors the full sweep per interval but still drains owed post-backs", async () => {
    const instance = agent("slack:T1:C1:111.222");
    const staleRun = transitionRun(
      createRun({
        runId: "r-stale",
        sandboxId: "sbx-stale",
        repoUrl: "https://github.com/o/r",
        task: "t",
        baseBranch: "main",
        publishPullRequest: false,
        approval: evidenceFor(
          {
            repoUrl: "https://github.com/o/r",
            task: "t",
            baseBranch: "main",
            publishPullRequest: false,
          },
          "ap-stale",
        ),
        now: 0,
      }),
      "running",
      undefined,
      0,
    );
    instance.state = { ...instance.state, runs: [staleRun] };
    const get = () => instance.onRequest(new Request("https://internal/api/runs"));

    // First read on a fresh lifetime sweeps — the stale run is reclaimed.
    expect((await get()).status).toBe(200);
    await flush();
    expect(instance.state.runs.find((r) => r.runId === "r-stale")?.status).toBe("unknown");

    // A second stale run + an owed outbox row land inside the floor —
    // the row replays like it survived a restart, so nothing claims it.
    instance.state = {
      ...instance.state,
      runs: [...instance.state.runs, { ...staleRun, runId: "r-second" }],
      outbox: [
        ...(instance.state.outbox ?? []),
        {
          id: "fx:slack.post:owed",
          effectKind: "slack.post",
          target: "slack:C1:111.222",
          status: "pending",
          attempts: 0,
          requestedAt: 0,
        },
      ],
    };
    expect((await get()).status).toBe(200);
    await flush();
    // Floored: no sweep — but the owed post still drained on the read.
    expect(instance.state.runs.find((r) => r.runId === "r-second")?.status).toBe("running");
    expect(
      instance.state.outbox?.find((e) => e.id === "fx:slack.post:owed")?.status,
    ).toBe("dispatched");

    // Past the floor, the next read sweeps again.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      expect((await get()).status).toBe(200);
      expect(instance.state.runs.find((r) => r.runId === "r-second")?.status).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });
});
