/**
 * GET /api/spine — the dashboard's window onto the orchestrator's event log.
 * Dashboard principals see the full spine; agent principals see only events
 * and outbox entries on runs they queued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import type { SpineEvent, OutboxEntry } from "@shiba/shared";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
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
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const AGENT_PRINCIPAL_HEADER = "X-Agent-Principal";

function agent() {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { Sandbox: {}, GITHUB_TOKEN: "test-token" },
    state: { runs: [] } as OrchestratorState,
    // The test subclass shadows the P9 setState override, so drive the
    // flush by hand — same order as production: apply → commit → drain.
    setState(this: CodingOrchestrator, next: OrchestratorState) {
      type SpineInternals = {
        applySpine(n: OrchestratorState): void;
        spineBuf: unknown;
      };
      const self = this as unknown as SpineInternals;
      self.applySpine(next);
      Object.assign(this, { state: next });
      self.spineBuf = [];
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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue("ok");
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
    const instance = agent();
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

  it("rejects non-GET methods", async () => {
    const instance = agent();
    const response = await instance.onRequest(
      new Request("https://internal/api/spine", { method: "POST" }),
    );
    expect(response.status).toBe(405);
  });
});
