import { describe, expect, it, vi } from "vitest";
import { ShibaClient } from "../src/client.js";
import { JsonRpcPeer, parseJsonRpc } from "../src/jsonrpc.js";
import { normalizeRepoUrl, ShibaAcpServer } from "../src/server.js";

/** Captured outbound frames + a fetch stub scripted per-request. */
function harness(opts: {
  spinePages?: Array<Record<string, unknown>>;
  runs?: Array<Record<string, unknown>>;
  run?: Record<string, unknown>;
  queueResult?: Record<string, unknown>;
  queueStatus?: number;
  resolveStatus?: number;
}) {
  const sent: Array<Record<string, unknown>> = [];
  const peer = new JsonRpcPeer((msg) => sent.push(msg));
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const spinePages = [...(opts.spinePages ?? [])];
  const client = new ShibaClient({
    baseUrl: "https://app.tryshiba.dev",
    token: "tok",
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (u.pathname === "/api/runs" && init?.method === "POST") return json(opts.queueResult ?? { ok: true, approvalId: "appr-1" }, opts.queueStatus ?? 200);
      if (u.pathname === "/api/runs" && init?.method === "GET") return json({ runs: opts.runs ?? [] });
      if (u.pathname.startsWith("/api/runs/") && init?.method === "GET") return json(opts.run ?? { runId: "run-1", status: "completed", summary: "done" });
      if (u.pathname.startsWith("/api/runs/") && init?.method === "DELETE") return json({ ok: true });
      if (u.pathname === "/api/approvals") return json({ result: "approved" }, opts.resolveStatus ?? 200);
      if (u.pathname === "/api/spine") return json(spinePages.shift() ?? { events: [], outbox: [], earliestSeq: 0, latestSeq: 0, totalEvents: 0 });
      return json({ error: "not found" }, 404);
    }) as typeof fetch,
  });
  const server = new ShibaAcpServer({
    client,
    peer,
    now: () => 1234,
    sleep: () => new Promise((r) => setImmediate(r)),
    execGitRemote: () => "git@github.com:owner/repo.git",
  });
  return { peer, server, sent, calls };
}

const handle = (h: ReturnType<typeof harness>, line: string) =>
  h.server.handle(parseJsonRpc(line)!);

describe("shiba-acp server", () => {
  it("answers initialize with protocol v1 + agent info", async () => {
    const h = harness({});
    await handle(h, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"zed","version":"0"}}}');
    expect(h.sent[0]).toMatchObject({
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "shiba-acp" },
      },
    });
    const caps = (h.sent[0] as { result: { agentCapabilities: Record<string, unknown> } }).result.agentCapabilities;
    expect(caps.promptCapabilities).toMatchObject({ text: true, image: false });
  });

  it("session/new returns a sessionId and resolves the repo remote", async () => {
    const h = harness({});
    await handle(h, '{"id":1,"method":"initialize","params":{}}');
    await handle(h, '{"id":2,"method":"session/new","params":{"cwd":"/repo","mcpServers":[]}}');
    const res = (h.sent[1] as { result: { sessionId?: string } }).result;
    expect(typeof res.sessionId).toBe("string");
  });

  it("rejects unknown methods with -32601", async () => {
    const h = harness({});
    await handle(h, '{"id":1,"method":"initialize","params":{}}');
    await handle(h, '{"id":2,"method":"session/hack","params":{}}');
    expect(h.sent[1]).toMatchObject({ id: 2, error: { code: -32601 } });
  });

  it("prompt → queueRun → permission → approved → run completes end_turn", async () => {
    const h = harness({
      runs: [{ runId: "run-1", status: "completed", summary: "shipped it", approval: { approvalId: "appr-1" } }],
      spinePages: [
        { events: [
          { seq: 1, at: 1, commandId: "queue:acp", kind: "approval.requested", approvalId: "appr-1" },
          { seq: 2, at: 2, commandId: "approval:appr-1", kind: "run.started", runId: "run-1" },
          { seq: 3, at: 3, commandId: "run", kind: "run.progress", runId: "run-1", payload: { summary: "working…" } },
        ], outbox: [], earliestSeq: 1, latestSeq: 3, totalEvents: 3 },
      ],
    });
    await handle(h, '{"id":1,"method":"initialize","params":{}}');
    await handle(h, '{"id":2,"method":"session/new","params":{"cwd":"/repo","mcpServers":[]}}');
    const sessionId = (h.sent[1] as { result: { sessionId: string } }).result.sessionId;

    const promptDone = handle(h, `{"id":3,"method":"session/prompt","params":{"sessionId":"${sessionId}","prompt":[{"type":"text","text":"fix the bug"}]}}`);
    await new Promise((r) => setImmediate(r));
    // The permission request went out — answer it like Zed would.
    const perm = h.sent.find((m) => m.method === "session/request_permission")!;
    expect(perm.params).toMatchObject({ sessionId, toolCall: { toolCallId: "appr-1" } });
    expect((perm.params as { options: Array<{ optionId: string }> }).options.map((o) => o.optionId)).toEqual(["approve", "reject"]);
    await handle(h, `{"id":${perm.id},"result":{"outcome":{"outcome":"selected","optionId":"approve"}}}`);
    await promptDone;

    // Queue → resolve → settled.
    expect(h.calls.find((c) => c.method === "POST" && c.path === "/api/runs")?.body).toMatchObject({
      repoUrl: "https://github.com/owner/repo",
      task: "fix the bug",
    });
    expect(h.calls.find((c) => c.path === "/api/approvals")?.body).toMatchObject({
      approvalId: "appr-1",
      approved: true,
      threadKey: `acp:${sessionId}`,
      decidedBy: "acp-client",
    });
    const last = h.sent[h.sent.length - 1]!;
    expect(last).toMatchObject({ id: 3, result: { stopReason: "end_turn" } });
    // Progress text became an agent_message_chunk.
    const chunks = h.sent.filter((m) => m.method === "session/update");
    expect(chunks.some((m) => JSON.stringify(m).includes("working…"))).toBe(true);
  });

  it("rejected permission resolves the approval rejected and returns refusal", async () => {
    const h = harness({});
    await handle(h, '{"id":1,"method":"initialize","params":{}}');
    await handle(h, '{"id":2,"method":"session/new","params":{"cwd":"/repo","mcpServers":[]}}');
    const sessionId = (h.sent[1] as { result: { sessionId: string } }).result.sessionId;
    const done = handle(h, `{"id":3,"method":"session/prompt","params":{"sessionId":"${sessionId}","prompt":[{"type":"text","text":"x"}]}}`);
    await new Promise((r) => setImmediate(r));
    const perm = h.sent.find((m) => m.method === "session/request_permission")!;
    await handle(h, `{"id":${perm.id},"result":{"outcome":{"outcome":"selected","optionId":"reject"}}}`);
    await done;
    expect(h.calls.find((c) => c.path === "/api/approvals")?.body).toMatchObject({ approved: false });
    expect(h.sent[h.sent.length - 1]).toMatchObject({ id: 3, result: { stopReason: "refusal" } });
  });

  it("session/cancel cancels the run and settles the prompt", async () => {
    const h = harness({ run: { runId: "run-1", status: "running" } });
    await handle(h, '{"id":1,"method":"initialize","params":{}}');
    await handle(h, '{"id":2,"method":"session/new","params":{"cwd":"/repo","mcpServers":[]}}');
    const sessionId = (h.sent[1] as { result: { sessionId: string } }).result.sessionId;
    const done = handle(h, `{"id":3,"method":"session/prompt","params":{"sessionId":"${sessionId}","prompt":[{"type":"text","text":"x"}]}}`);
    await new Promise((r) => setImmediate(r));
    const perm = h.sent.find((m) => m.method === "session/request_permission")!;
    await handle(h, `{"id":${perm.id},"result":{"outcome":{"outcome":"selected","optionId":"approve"}}}`);
    // Let the pump bind the runId, then cancel.
    await handle(h, `{"method":"session/cancel","params":{"sessionId":"${sessionId}"}}`);
    await done;
    expect(h.sent[h.sent.length - 1]).toMatchObject({ id: 3, result: { stopReason: "cancelled" } });
  });

  it("surfaces queue errors as JSON-RPC errors on the prompt call", async () => {
    const h = harness({ queueStatus: 400, queueResult: { error: "Invalid repository URL." } });
    await handle(h, '{"id":1,"method":"initialize","params":{}}');
    await handle(h, '{"id":2,"method":"session/new","params":{"cwd":"/repo","mcpServers":[]}}');
    const sessionId = (h.sent[1] as { result: { sessionId: string } }).result.sessionId;
    await handle(h, `{"id":3,"method":"session/prompt","params":{"sessionId":"${sessionId}","prompt":[{"type":"text","text":"x"}]}}`);
    expect(h.sent[h.sent.length - 1]).toMatchObject({ id: 3, error: { code: -32603 } });
  });
});

describe("normalizeRepoUrl", () => {
  it("converts ssh and https remotes", () => {
    expect(normalizeRepoUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizeRepoUrl("ssh://git@github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizeRepoUrl("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizeRepoUrl("")).toBeNull();
  });
});
