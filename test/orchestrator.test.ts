import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import { createRun, RUN_DEADLINE_MS, type DelegatedRun } from "../src/runs.js";
import { parseAgentToolInput } from "../src/opencode-input.js";

const mocks = vi.hoisted(() => ({ destroy: vi.fn(), execute: vi.fn() }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => ({ destroy: mocks.destroy }) }));

function agent() {
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: { Sandbox: {}, GITHUB_TOKEN: "test-token" }, state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) { Object.assign(this, { state }); },
  });
  return instance;
}

function retained(status: "running" | "completed" = "running") {
  return { ...createRun({ runId: "r1", sandboxId: "s1", repoUrl: "https://github.com/o/r",
    task: "fix", baseBranch: "main", publishPullRequest: false, now: Date.now() - RUN_DEADLINE_MS - 1 }), status };
}

beforeEach(() => { vi.resetAllMocks(); mocks.destroy.mockResolvedValue(undefined); });

describe("orchestrator run routes", () => {
  it("reclaims stale runs on GET and destroys their sandbox", async () => {
    const instance = agent();
    instance.setState({ runs: [retained()] });
    const response = await instance.onRequest(new Request("https://internal/api/runs"));
    const body = (await response.json()) as { runs: { status: string; errorCode?: string }[] };
    expect(body.runs[0]?.status).toBe("unknown");
    expect(body.runs[0]?.errorCode).toBe("outcome_unknown");
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("does not destroy completed runs when cancelling", async () => {
    const instance = agent();
    instance.setState({ runs: [retained("completed")] });
    const response = await instance.onRequest(new Request("https://internal/api/runs/r1", { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("cancels active sandboxes before clearing history", async () => {
    const instance = agent();
    instance.setState({ runs: [{ ...retained(), updatedAt: Date.now() }] });
    const response = await instance.onRequest(new Request("https://internal/api/runs", { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(instance.state.runs).toEqual([]);
  });

  it("rejects malformed run IDs without throwing", async () => {
    expect((await agent().onRequest(new Request("https://internal/api/runs/%ZZ"))).status).toBe(400);
  });

  it("returns 404 for missing runs and refuses ungated POST requests", async () => {
    expect((await agent().onRequest(new Request("https://internal/api/runs/missing"))).status).toBe(404);
    expect((await agent().onRequest(new Request("https://internal/api/runs/r1", { method: "POST" }))).status).toBe(405);
    // POST /api/runs is the queue route now; an empty body fails validation.
    expect((await agent().onRequest(new Request("https://internal/api/runs", { method: "POST" }))).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("posts run cancellation back to the originating Slack thread", async () => {
    const instance = agent();
    Object.assign(instance, {
      name: "slack:T1:C9:1700.0001",
      ctx: { waitUntil: vi.fn((p: Promise<unknown>) => p) },
    });
    Object.assign(instance.env, { SLACK_BOT_TOKEN: "xoxb-test" });
    instance.setState({ runs: [{ ...retained(), updatedAt: Date.now() }] });
    const fetchMock = vi.fn(async (_url: unknown, _init?: { body?: unknown }) =>
      new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await instance.onRequest(
        new Request("https://internal/api/runs/r1", { method: "DELETE" }),
      );
      expect(response.status).toBe(200);
      const postCalls = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("chat.postMessage"));
      expect(postCalls).toHaveLength(1);
      const body = JSON.parse(String(postCalls[0]![1]?.body)) as Record<string, string>;
      expect(body.channel).toBe("C9");
      expect(body.thread_ts).toBe("1700.0001");
      expect(body.text).toContain("cancelled");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips post-back for non-Slack orchestrators", async () => {
    const instance = agent();
    Object.assign(instance, {
      name: "default",
      ctx: { waitUntil: vi.fn((p: Promise<unknown>) => p) },
    });
    Object.assign(instance.env, { SLACK_BOT_TOKEN: "xoxb-test" });
    instance.setState({ runs: [{ ...retained(), updatedAt: Date.now() }] });
    const fetchMock = vi.fn(async (_url: unknown) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await instance.onRequest(new Request("https://internal/api/runs/r1", { method: "DELETE" }));
      expect(
        fetchMock.mock.calls.filter((call) => String(call[0]).includes("chat.postMessage")),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("propagates cancellation to the running child execution", async () => {
    const instance = agent();
    mocks.execute.mockImplementation(async (_input, options: { abortSignal?: AbortSignal }) => {
      // The child hangs like a real container run until its signal aborts.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        options?.abortSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Run cancelled."));
        });
      });
      return "unreachable";
    });
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<string>;
    };
    const execution = delegate.execute(
      { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "tc1" },
    );
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    await instance.cancelRun("agent-tool:tc1");
    await expect(execution).rejects.toThrow("Run cancelled");
    expect((instance.state.runs as DelegatedRun[])[0]?.status).toBe("cancelled");
  });

  it("reclaims a stale run and aborts its child execution", async () => {
    const instance = agent();
    const signals: (AbortSignal | undefined)[] = [];
    mocks.execute.mockImplementation(async (_input, options: { abortSignal?: AbortSignal }) => {
      signals.push(options?.abortSignal);
      await new Promise(() => {}); // never resolves; only cancellation ends it
      return "unreachable";
    });
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const execution = delegate.execute(
      { repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "tc2" },
    );
    execution.catch(() => {});
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    // Age the run past its deadline, then touch any route (reclaim on access).
    const stale = { ...(instance.state.runs as DelegatedRun[])[0]!, updatedAt: Date.now() - RUN_DEADLINE_MS - 1 };
    instance.setState({ ...instance.state, runs: [stale] });
    await instance.onRequest(new Request("https://internal/api/runs"));
    expect(signals[0]?.aborted).toBe(true);
    expect((instance.state.runs as DelegatedRun[])[0]?.status).toBe("unknown");
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("approve at the concurrency cap stays pending and returns 409, no execution", async () => {
    const instance = agent();
    // Five active runs: one slot past MAX_CONCURRENT_RUNS.
    instance.setState({ runs: Array.from({ length: 5 }, (_, i) =>
      ({ ...createRun({ runId: `r${i}`, sandboxId: `s${i}`, repoUrl: "https://github.com/o/r", task: "t", baseBranch: "main", publishPullRequest: false }), status: "running" as const, updatedAt: Date.now() }),
    ) as DelegatedRun[] });
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "cap check" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    mocks.execute.mockResolvedValue("ok");
    const response = await instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
    }));
    expect(response.status).toBe(409);
    // Pointer survives: a later approve after a slot frees can still start it.
    const approvals = (instance.state.pendingApprovals ?? []) as { approvalId: string; status: string }[];
    expect(approvals.find((a) => a.approvalId === approvalId)?.status).toBe("pending");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects non-object JSON bodies on queue and approval routes", async () => {
    const instance = agent();
    for (const body of ["null", "[]", '"str"', "5"]) {
      const queueRes = await instance.onRequest(new Request("https://internal/api/runs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      }));
      expect(queueRes.status).toBe(400);
      const approvalRes = await instance.onRequest(new Request("https://internal/api/approvals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      }));
      expect(approvalRes.status).toBe(400);
    }
  });

  it("rejects a Slack-sourced request with no task fields and records no approval", async () => {
    const instance = agent();
    const response = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "slack" }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toMatch(/repo|url/i);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(instance.state.runs).toEqual([]);
  });

  it("queues a slash-command run as a pending approval without executing", async () => {
    const instance = agent();
    const response = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix it", source: "slack" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { approvalId?: string };
    expect(body.approvalId).toBeTruthy();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(instance.state.runs).toEqual([]); // no container, no run record yet
    expect(instance.state.pendingApprovals).toHaveLength(1);
    expect(instance.state.pendingApprovals?.[0]?.threadKey).toBe("default");
  });

  it("stores the provided threadKey on a queued mention approval", async () => {
    const instance = agent();
    const threadKey = "slack:T:C:1758217392.000100";
    const response = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix it", threadKey, source: "slack" }),
    }));
    expect(response.status).toBe(200);
    expect(instance.state.pendingApprovals?.[0]?.threadKey).toBe(threadKey);
  });

  it("resolves an approval exactly once; approve runs the frozen input, reject runs nothing", async () => {
    const instance = agent();
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix it", baseBranch: "develop" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    mocks.execute.mockResolvedValue("ok");
    const pointer = { threadKey: "default", approvalId };
    const post = (approved: boolean) => instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pointer, approved, decidedBy: "U1" }),
    }));

    const rejected = await post(false);
    expect((await rejected.json() as { result: string }).result).toBe("rejected");
    expect(mocks.execute).not.toHaveBeenCalled();

    // Rejected is terminal: an approve replay resolves nothing and runs nothing.
    const replay = await post(true);
    expect((await replay.json() as { result: string }).result).toBe("unknown");
    expect(mocks.execute).not.toHaveBeenCalled();

    // A fresh approval runs the exact frozen input through the gated path.
    const second = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "second", baseBranch: "develop", publishPullRequest: true, source: "slack" }),
    }));
    const { approvalId: freshId } = await second.json() as { approvalId: string };
    const approved = await instance.onRequest(new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId: freshId, approved: true, decidedBy: "U1" }),
    }));
    expect((await approved.json() as { result: string }).result).toBe("approved");
    expect(mocks.execute).toHaveBeenCalledOnce();
    const calls = mocks.execute.mock.calls as unknown as [[string, { toolCallId: string }]];
    expect(parseAgentToolInput([{ role: "user", text: calls[0]![0]! }])).toMatchObject({ task: "second", baseBranch: "develop", publishPullRequest: true });
  });
});

describe("approval handoff recovery", () => {
  it("persists decision and run together before dispatch, then fails interrupted work on restart", async () => {
    const instance = agent();
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix" }),
    }));
    const { approvalId } = await queued.json() as { approvalId: string };
    let crashState: OrchestratorState | undefined;
    const writes: OrchestratorState[] = [];
    instance.setState = (state) => {
      writes.push(structuredClone(state));
      Object.assign(instance, { state });
    };
    // Snapshot exactly at dispatch entry, before any child execution can start.
    instance.getTools = () => {
      crashState = structuredClone(instance.state);
      throw new Error("Simulated process interruption before dispatch");
    };
    const request = () => new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "U1" }),
    });
    expect((await instance.onRequest(request())).status).toBe(200);
    expect(writes[0]?.pendingApprovals?.[0]?.status).toBe("approved");
    expect(writes[0]?.runs[0]?.status).toBe("pending");
    expect(crashState?.runs).toHaveLength(1);
    expect(crashState?.runs[0]?.status).toBe("pending");
    expect(mocks.execute).not.toHaveBeenCalled();

    const restarted = agent();
    restarted.setState(JSON.parse(JSON.stringify(crashState)) as OrchestratorState);
    await restarted.onStart();
    expect(restarted.state.runs[0]?.status).toBe("unknown");
    expect(restarted.state.runs[0]?.errorCode).toBe("outcome_unknown");
    expect(restarted.state.runs[0]?.error).toContain("orchestrator restart");
    expect(restarted.state.pendingApprovals?.[0]?.status).toBe("approved");
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(await (await restarted.onRequest(request())).json()).toEqual({ result: "unknown" });
    expect(restarted.state.runs).toHaveLength(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("combined cancellation signals", () => {
  it.each(["caller", "run"])("aborts child from %s cancellation and releases controller", async (source) => {
    const instance = agent();
    const caller = new AbortController();
    mocks.execute.mockImplementation(async (_input, options: { abortSignal: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    const execution = delegate.execute({ repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "combined", abortSignal: caller.signal });
    const outcome = expect(execution).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    if (source === "caller") caller.abort();
    else await instance.cancelRun("agent-tool:combined");
    await outcome;
    expect((instance as unknown as { runControllersMap: Map<string, AbortController> }).runControllersMap.size).toBe(0);
  });

  it("does not dispatch or retain a run for an already-aborted caller", async () => {
    const instance = agent();
    const caller = new AbortController();
    caller.abort(new Error("already cancelled"));
    const delegate = instance.getTools()["delegate_coding_task"] as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    await expect(delegate.execute({ repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false },
      { toolCallId: "pre-abort", abortSignal: caller.signal })).rejects.toThrow("already cancelled");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(instance.state.runs).toEqual([]);
  });
});
