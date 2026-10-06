import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
  destroyManagedContainer: async () => {},
  leakedContainers: () => [],
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (ns: any, name: string) => {
    if (ns && typeof ns.get === "function") {
      return ns.get(name);
    }
    return {
      fetch: async () => new Response("{}", { status: 404 }),
    };
  },
  // Mirrors the SDK: null for paths outside the /agents/ prefix (so later
  // fallthrough logic runs), a stubbed 200 for in-prefix paths the tests
  // assert on as "forwarded to the DO".
  routeAgentRequest: async (request: Request) =>
    new URL(request.url).pathname.startsWith("/agents/")
      ? new Response(null, { status: 200 })
      : null,
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
    onConnect() {}
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return { fetch: async () => Response.json({ mcp: "served" }) };
    }
  },
}));

import {
  buildSessionAgentName,
  createWebSession,
  DEFAULT_SESSION_ID,
  DEFAULT_SESSION_NAME,
  findSession,
  formatSessionList,
  isAuthorizedSessionAgent,
  isDashboardAgentName,
  isValidSessionId,
  MAX_METADATA_KEYS,
  MAX_METADATA_KEY_LENGTH,
  MAX_METADATA_VALUE_LENGTH,
  MAX_SESSIONS_PER_USER,
  mintSessionId,
  parseSessionAgentName,
  sanitizeSessionMetadata,
  sanitizeSessionName,
  SESSION_UUID_REGEX,
  validateSessionRecordIntegrity,
  type WebSessionRecord,
} from "../src/web-sessions.js";
import {
  CodingOrchestrator,
  SESSION_DELETED_CLOSE_CODE,
  type OrchestratorState,
} from "../src/agents/orchestrator.js";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import type { PendingApproval } from "../src/pending-approvals.js";

describe("web-sessions module (T30/T32)", () => {
  describe("mintSessionId", () => {
    it("generates valid UUIDv4 strings and unique values", () => {
      const id1 = mintSessionId();
      const id2 = mintSessionId();
      expect(SESSION_UUID_REGEX.test(id1)).toBe(true);
      expect(SESSION_UUID_REGEX.test(id2)).toBe(true);
      expect(id1).not.toBe(id2);
    });
  });

  describe("isValidSessionId", () => {
    it("accepts default and valid UUIDs", () => {
      expect(isValidSessionId(DEFAULT_SESSION_ID)).toBe(true);
      expect(isValidSessionId("c7b8d4c0-4f5b-4d7a-8b1e-2e4d6a7b8c9d")).toBe(true);
      expect(isValidSessionId("C7B8D4C0-4F5B-4D7A-8B1E-2E4D6A7B8C9D")).toBe(true);
    });

    it("rejects path traversal, malicious characters, or malformed strings", () => {
      expect(isValidSessionId("../session")).toBe(false);
      expect(isValidSessionId("default/../../etc")).toBe(false);
      expect(isValidSessionId("session:123")).toBe(false);
      expect(isValidSessionId("")).toBe(false);
      expect(isValidSessionId("   ")).toBe(false);
      expect(isValidSessionId("not-a-uuid")).toBe(false);
      expect(isValidSessionId(null as unknown as string)).toBe(false);
      expect(isValidSessionId(undefined as unknown as string)).toBe(false);
    });
  });

  describe("sanitizeSessionName", () => {
    it("sanitizes whitespace and control characters and enforces length ceiling", () => {
      expect(sanitizeSessionName("  Fix Auth Bug  ")).toBe("Fix Auth Bug");
      expect(sanitizeSessionName("Line\nBreak\x00Clean")).toBe("LineBreakClean");
      expect(sanitizeSessionName(12345)).toBe("");
      expect(sanitizeSessionName(null)).toBe("");
      const longName = "a".repeat(150);
      expect(sanitizeSessionName(longName).length).toBe(100);
    });
  });

  describe("sanitizeSessionMetadata", () => {
    it("accepts plain objects with primitive values within limits", () => {
      const valid = { project: "shiba", branch: "feat", count: 42, active: true, tag: null };
      expect(sanitizeSessionMetadata(valid)).toEqual(valid);
      expect(sanitizeSessionMetadata(undefined)).toBeUndefined();
      expect(sanitizeSessionMetadata(null)).toBeUndefined();
      expect(sanitizeSessionMetadata({})).toBeUndefined();
    });

    it("rejects non-plain objects, arrays, and functions", () => {
      expect(() => sanitizeSessionMetadata(["item"])).toThrow("plain object");
      expect(() => sanitizeSessionMetadata(new Date())).toThrow("plain object");
      expect(() => sanitizeSessionMetadata("string")).toThrow("plain object");
      expect(() => sanitizeSessionMetadata({ fn: () => {} })).toThrow("must be a string, number, boolean, or null");
      expect(() => sanitizeSessionMetadata({ nested: { a: 1 } })).toThrow("must be a string, number, boolean, or null");
    });

    it("enforces key length, key count, and value length limits", () => {
      const longKey = "k".repeat(MAX_METADATA_KEY_LENGTH + 1);
      expect(() => sanitizeSessionMetadata({ [longKey]: "val" })).toThrow("Invalid metadata key");

      const tooManyKeys: Record<string, string> = {};
      for (let i = 0; i <= MAX_METADATA_KEYS; i++) tooManyKeys[`k${i}`] = "val";
      expect(() => sanitizeSessionMetadata(tooManyKeys)).toThrow("exceeds key limit");

      const longValue = "v".repeat(MAX_METADATA_VALUE_LENGTH + 1);
      expect(() => sanitizeSessionMetadata({ key: longValue })).toThrow("exceeds limit");
    });

    it("enforces total serialized byte size ceiling", () => {
      const payload: Record<string, string> = {};
      // 9 keys of 1000 chars exceeds 8192 bytes
      for (let i = 0; i < 9; i++) {
        payload[`key_${i}`] = "x".repeat(950);
      }
      expect(() => sanitizeSessionMetadata(payload)).toThrow("exceeds size limit");
    });
  });

  describe("buildSessionAgentName and parseSessionAgentName", () => {
    it("preserves base session compatibility when sessionId is default", () => {
      expect(buildSessionAgentName("alice@example.com", DEFAULT_SESSION_ID)).toBe("alice@example.com");
      expect(buildSessionAgentName("default", DEFAULT_SESSION_ID)).toBe("default");
    });

    it("constructs web:<userId>:<sessionId> for named sessions", () => {
      const sessionId = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";
      expect(buildSessionAgentName("alice@example.com", sessionId)).toBe(
        `web:alice@example.com:${sessionId}`,
      );
    });

    it("throws on invalid userId or sessionId", () => {
      expect(() => buildSessionAgentName("", "default")).toThrow();
      expect(() => buildSessionAgentName("alice", "../invalid")).toThrow();
    });

    it("parses valid web session agent names", () => {
      const sessionId = "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d";
      const parsed = parseSessionAgentName(`web:user+tag@domain.com:${sessionId}`);
      expect(parsed).toEqual({
        userId: "user+tag@domain.com",
        sessionId,
      });
    });

    it("returns null for non-web or malformed agent names", () => {
      expect(parseSessionAgentName("alice@example.com")).toBeNull();
      expect(parseSessionAgentName("slack:T1:C1:12345")).toBeNull();
      expect(parseSessionAgentName("web::sessionId")).toBeNull();
      expect(parseSessionAgentName("web:alice:")).toBeNull();
      expect(parseSessionAgentName("web:alice:not-a-uuid")).toBeNull();
    });

    it("rejects the web:<user>:default alias for the base session", () => {
      // The base session is only reachable as bare userId; a web:-prefixed
      // "default" alias must never parse, authorize, or persist.
      expect(parseSessionAgentName("web:alice@example.com:default")).toBeNull();
      expect(parseSessionAgentName("web:default:default")).toBeNull();
    });
  });

  describe("isDashboardAgentName (local-runtime surface gate)", () => {
    it("positive-lists base user DOs and strict web sessions only", () => {
      // The two dashboard shapes.
      expect(isDashboardAgentName("alice@example.com")).toBe(true);
      expect(isDashboardAgentName("user-123")).toBe(true);
      expect(
        isDashboardAgentName("web:alice@example.com:a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d"),
      ).toBe(true);

      // Chat-lane DO names and every other prefixed shape are out — the
      // predicate must not allow by fallthrough.
      expect(isDashboardAgentName("slack:T1:C1:1699.0001")).toBe(false);
      expect(isDashboardAgentName("discord:1234567890")).toBe(false);
      expect(isDashboardAgentName("telegram:42")).toBe(false);
      expect(isDashboardAgentName("web:conversation-7")).toBe(false); // chat thread DO
      expect(isDashboardAgentName("email:abc")).toBe(false);
      expect(isDashboardAgentName("anything:else")).toBe(false);

      // Malformed web sessions and the shared default DO are out too.
      expect(isDashboardAgentName("web:alice@example.com:not-a-uuid")).toBe(false);
      expect(isDashboardAgentName(`web:alice@example.com:${DEFAULT_SESSION_ID}`)).toBe(false);
      expect(isDashboardAgentName(DEFAULT_SESSION_ID)).toBe(false);
      expect(isDashboardAgentName("")).toBe(false);
      expect(isDashboardAgentName(undefined)).toBe(false);
    });
  });

  describe("validateSessionRecordIntegrity (registry validation)", () => {
    const alice = "alice@example.com";

    it("accepts a well-formed server-minted record", () => {
      const session = createWebSession(alice, { name: "Good" });
      expect(validateSessionRecordIntegrity(session, alice)).toBeNull();
    });

    it("rejects default/non-UUID ids, so web:<user>:default can never persist", () => {
      const session = createWebSession(alice, { name: "Alias" });
      expect(validateSessionRecordIntegrity({ ...session, id: DEFAULT_SESSION_ID }, alice))
        .toContain("Invalid session id");
      expect(validateSessionRecordIntegrity({ ...session, id: "../evil" }, alice))
        .toContain("Invalid session id");
    });

    it("rejects userId mismatches and agentName forgery", () => {
      const session = createWebSession(alice, { name: "Owned" });
      expect(validateSessionRecordIntegrity(session, "bob@example.com"))
        .toContain("userId does not match");
      expect(validateSessionRecordIntegrity(
        { ...session, agentName: "web:eve@example.com:aaa" },
        alice,
      )).toContain("agentName");
    });

    it("rejects malformed shapes and timestamps", () => {
      expect(validateSessionRecordIntegrity(null)).toContain("Invalid session record");
      expect(validateSessionRecordIntegrity({ id: mintSessionId() })).not.toBeNull();
      const session = createWebSession(alice);
      expect(validateSessionRecordIntegrity({ ...session, createdAt: -1 })).toContain("timestamps");
      expect(validateSessionRecordIntegrity({ ...session, name: "" })).toContain("name");
    });
  });

  describe("byte-accurate metadata limits", () => {
    it("counts metadata value limits in bytes, not characters", () => {
      // 600 two-byte chars: under the char ceiling, over the byte ceiling.
      const value = "é".repeat(Math.floor(MAX_METADATA_VALUE_LENGTH / 2) + 1);
      expect(() => sanitizeSessionMetadata({ key: value })).toThrow("exceeds limit");
      // ASCII at the boundary still passes.
      const ok = "a".repeat(MAX_METADATA_VALUE_LENGTH);
      expect(sanitizeSessionMetadata({ key: ok })).toEqual({ key: ok });
    });
  });

  describe("isAuthorizedSessionAgent (safe per-user routing)", () => {
    const alice = "alice@example.com";
    const bob = "bob@example.com";
    const validUuid = "11111111-2222-4333-8444-555555555555";

    it("authorizes base session for the authenticated user", () => {
      expect(isAuthorizedSessionAgent(alice, alice)).toBe(true);
      expect(isAuthorizedSessionAgent("default", "default")).toBe(true);
    });

    it("authorizes named session belonging to the authenticated user", () => {
      expect(isAuthorizedSessionAgent(`web:${alice}:${validUuid}`, alice)).toBe(true);
    });

    it("strictly blocks cross-user session routing", () => {
      expect(isAuthorizedSessionAgent(bob, alice)).toBe(false);
      expect(isAuthorizedSessionAgent(`web:${bob}:${validUuid}`, alice)).toBe(false);
      expect(isAuthorizedSessionAgent("default", alice)).toBe(false);
    });

    it("strictly blocks Slack thread names, malformed names, and injection attempts", () => {
      expect(isAuthorizedSessionAgent("slack:T1:C1:12345", alice)).toBe(false);
      expect(isAuthorizedSessionAgent("automations", alice)).toBe(false);
      expect(isAuthorizedSessionAgent(`web:${alice}:../traversal`, alice)).toBe(false);
      expect(isAuthorizedSessionAgent(`web:${alice}:`, alice)).toBe(false);
      expect(isAuthorizedSessionAgent("", alice)).toBe(false);
    });
  });

  describe("createWebSession and session list management", () => {
    it("creates server-minted session records with bounded metadata", () => {
      const session = createWebSession("alice@example.com", {
        name: "Refactor API",
        metadata: { purpose: "backend", priority: 1 },
      });
      expect(SESSION_UUID_REGEX.test(session.id)).toBe(true);
      expect(session.userId).toBe("alice@example.com");
      expect(session.name).toBe("Refactor API");
      expect(session.agentName).toBe(`web:alice@example.com:${session.id}`);
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.updatedAt).toBe(session.createdAt);
      expect(session.metadata).toEqual({ purpose: "backend", priority: 1 });
    });

    it("formatSessionList always includes base session and isolates per user", () => {
      const alice = "alice@example.com";
      const s1 = createWebSession(alice, { name: "Session 1" });
      const s2 = createWebSession(alice, { name: "Session 2" });
      s1.updatedAt = 1000;
      s2.updatedAt = 2000;
      const bobSession = createWebSession("bob@example.com", { name: "Bob's Session" });

      const list = formatSessionList(alice, [s1, bobSession, s2]);
      expect(list.length).toBe(3);
      expect(list[0]?.id).toBe(DEFAULT_SESSION_ID);
      expect(list[0]?.name).toBe(DEFAULT_SESSION_NAME);
      expect(list[0]?.agentName).toBe(alice);
      expect(list.map((s) => s.id)).toEqual([DEFAULT_SESSION_ID, s2.id, s1.id]);
    });

    it("findSession resolves base session and stored sessions", () => {
      const alice = "alice@example.com";
      const s1 = createWebSession(alice, { name: "Session 1" });
      expect(findSession(alice, [s1], DEFAULT_SESSION_ID)?.id).toBe(DEFAULT_SESSION_ID);
      expect(findSession(alice, [s1], s1.id)?.name).toBe("Session 1");
      expect(findSession(alice, [s1], "non-existent")).toBeNull();
      expect(findSession("bob@example.com", [s1], s1.id)).toBeNull();
    });
  });
});

describe("CodingOrchestrator internal web-sessions handler and teardown", () => {
  function mockConnection() {
    return { close: vi.fn(), send: vi.fn() };
  }

  function createTestOrchestrator(
    initialSessions: WebSessionRecord[] = [],
    connections: ReturnType<typeof mockConnection>[] = [],
  ): CodingOrchestrator {
    const orchestrator = Object.create(CodingOrchestrator.prototype) as CodingOrchestrator;
    const state: OrchestratorState = { runs: [], webSessions: initialSessions, pendingApprovals: [] };
    Object.assign(orchestrator, {
      state,
      cancelRun: vi.fn(async () => {}),
      reclaimRuns: vi.fn(async () => {}),
      getConnections: () => connections,
      setState(s: OrchestratorState) {
        Object.assign(this, { state: s });
      },
    });
    Object.defineProperty(orchestrator, "store", {
      value: { list: () => (orchestrator.state as OrchestratorState).runs ?? [] },
      configurable: true,
      writable: true,
    });
    return orchestrator;
  }

  it("handles GET /internal/web-sessions", async () => {
    const session = createWebSession("alice", { name: "Test" });
    const orchestrator = createTestOrchestrator([session]);

    const res = await orchestrator.onRequest(
      new Request("https://internal/internal/web-sessions", { method: "GET" }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessions: WebSessionRecord[] };
    expect(data.sessions).toEqual([session]);
  });

  it("handles POST /internal/web-sessions and enforces MAX_SESSIONS_PER_USER", async () => {
    const orchestrator = createTestOrchestrator([]);
    const session = createWebSession("alice", { name: "New Session" });

    const res = await orchestrator.onRequest(
      new Request("https://internal/internal/web-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session }),
      }),
    );
    expect(res.status).toBe(201);
    expect(orchestrator.storedWebSessions.length).toBe(1);

    // Limit check
    const fullOrchestrator = createTestOrchestrator(
      Array.from({ length: MAX_SESSIONS_PER_USER }, (_, i) =>
        createWebSession("alice", { name: `Session ${i}` }),
      ),
    );
    const overflow = createWebSession("alice", { name: "Overflow" });
    const overflowRes = await fullOrchestrator.onRequest(
      new Request("https://internal/internal/web-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: overflow }),
      }),
    );
    expect(overflowRes.status).toBe(400);
    const err = (await overflowRes.json()) as { error: string };
    expect(err.error).toContain("Maximum session limit reached");
  });

  it("handles session teardown: rejects 409 when active resources exist without force", async () => {
    const orchestrator = createTestOrchestrator();
    // Simulate active running task
    (orchestrator.state as OrchestratorState).runs = [
      { runId: "r1", status: "running", sandboxId: "s1" } as any,
    ];
    (orchestrator.state as OrchestratorState).pendingApprovals = [
      { approvalId: "a1", status: "pending", threadKey: "web:alice:123" } as any,
    ];

    // Teardown without force -> 409
    const resNoForce = await orchestrator.onRequest(
      new Request("https://internal/internal/session-teardown", { method: "POST" }),
    );
    expect(resNoForce.status).toBe(409);
    const err = (await resNoForce.json()) as { error: string; activeRuns: number; pendingApprovals: number };
    expect(err.activeRuns).toBe(1);
    expect(err.pendingApprovals).toBe(1);

    // Teardown with force=true -> cancels runs, rejects approvals, returns 200
    const resForce = await orchestrator.onRequest(
      new Request("https://internal/internal/session-teardown?force=true", { method: "POST" }),
    );
    expect(resForce.status).toBe(200);
    expect(orchestrator.cancelRun).toHaveBeenCalledWith("r1");
    expect((orchestrator.state as OrchestratorState).pendingApprovals?.[0]?.status).toBe("rejected");
    expect(orchestrator.reclaimRuns).toHaveBeenCalled();
  });

  it("rejects malformed registry records (non-UUID id, forged agentName, userId mismatch)", async () => {
    const named = createTestOrchestrator([]);
    Object.defineProperty(named, "name", { value: "alice@example.com", configurable: true });
    const good = createWebSession("alice@example.com", { name: "Real" });

    const post = (session: unknown) =>
      named.onRequest(
        new Request("https://internal/internal/web-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session }),
        }),
      );

    expect((await post({ ...good, id: DEFAULT_SESSION_ID })).status).toBe(400);
    expect((await post({ ...good, agentName: `web:eve@example.com:${good.id}` })).status).toBe(400);
    expect((await post(createWebSession("mallory@example.com"))).status).toBe(400);
    expect((await post("not-an-object")).status).toBe(400);
    expect((await post(good)).status).toBe(201);
  });

  it("tombstoned sessions are hidden from list/lookup/resume until delete completes", async () => {
    const session = createWebSession("alice", { name: "Going Away" });
    const orchestrator = createTestOrchestrator([session]);

    // Mark deleting
    const markRes = await orchestrator.onRequest(
      new Request(`https://internal/internal/web-sessions/${session.id}/deleting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleting: true }),
      }),
    );
    expect(markRes.status).toBe(200);
    expect(((await markRes.json()) as { session: WebSessionRecord }).session.deletingAt).toBeGreaterThan(0);

    // List hides it; GET/resume/PATCH all 404
    const listRes = await orchestrator.onRequest(
      new Request("https://internal/internal/web-sessions", { method: "GET" }),
    );
    expect(((await listRes.json()) as { sessions: WebSessionRecord[] }).sessions).toHaveLength(0);
    const getRes = await orchestrator.onRequest(
      new Request(`https://internal/internal/web-sessions/${session.id}`),
    );
    expect(getRes.status).toBe(404);
    const resumeRes = await orchestrator.onRequest(
      new Request(`https://internal/internal/web-sessions/${session.id}/resume`, { method: "POST" }),
    );
    expect(resumeRes.status).toBe(404);

    // includeDeleting lets the delete retry path still resolve it
    const internalGet = await orchestrator.onRequest(
      new Request(`https://internal/internal/web-sessions/${session.id}?includeDeleting=true`),
    );
    expect(internalGet.status).toBe(200);

    // Unmark (rollback) restores visibility
    await orchestrator.onRequest(
      new Request(`https://internal/internal/web-sessions/${session.id}/deleting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleting: false }),
      }),
    );
    const getRes2 = await orchestrator.onRequest(
      new Request(`https://internal/internal/web-sessions/${session.id}`),
    );
    expect(getRes2.status).toBe(200);
  });

  const teardown = (orchestrator: CodingOrchestrator, force = false) =>
    orchestrator.onRequest(
      new Request(`https://internal/internal/session-teardown${force ? "?force=true" : ""}`, { method: "POST" }),
    );

  it("teardown persists the deleted flag and closes live sockets", async () => {
    const live = [mockConnection(), mockConnection()];
    const orchestrator = createTestOrchestrator([], live);

    const res = await teardown(orchestrator);
    expect(res.status).toBe(200);
    expect((orchestrator.state as OrchestratorState).sessionDeletedAt).toBeGreaterThan(0);
    for (const connection of live) {
      expect(connection.close).toHaveBeenCalledWith(SESSION_DELETED_CLOSE_CODE, "Session deleted.");
    }
  });

  it("a busy non-force teardown (409) leaves the session live and sockets open", async () => {
    const live = [mockConnection()];
    const orchestrator = createTestOrchestrator([], live);
    (orchestrator.state as OrchestratorState).runs = [{ runId: "r1", status: "running", sandboxId: "s1" } as any];

    expect((await teardown(orchestrator)).status).toBe(409);
    expect((orchestrator.state as OrchestratorState).sessionDeletedAt).toBeUndefined();
    expect(live[0]!.close).not.toHaveBeenCalled();
    expect(orchestrator.cancelRun).not.toHaveBeenCalled();
  });

  it("flags the session before awaiting run cancellation, so racing work sees it", async () => {
    const orchestrator = createTestOrchestrator();
    (orchestrator.state as OrchestratorState).runs = [{ runId: "r1", status: "running", sandboxId: "s1" } as any];
    let flaggedDuringCancel: number | undefined;
    (orchestrator as any).cancelRun = vi.fn(async () => {
      flaggedDuringCancel = (orchestrator.state as OrchestratorState).sessionDeletedAt;
    });

    expect((await teardown(orchestrator, true)).status).toBe(200);
    expect(flaggedDuringCancel).toBeGreaterThan(0);
  });

  it("requests that passed the Worker's registry check are refused once deleted", async () => {
    const orchestrator = createTestOrchestrator();
    await teardown(orchestrator);

    const queue = await orchestrator.onRequest(
      new Request("https://internal/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "t" }),
      }),
    );
    expect(queue.status).toBe(410);
    const approve = await orchestrator.onRequest(
      new Request("https://internal/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadKey: "k", approvalId: "a", approved: true, decidedBy: "alice" }),
      }),
    );
    expect(approve.status).toBe(410);
    expect((await orchestrator.onRequest(new Request("https://internal/api/runs"))).status).toBe(410);
    expect((orchestrator.state as OrchestratorState).pendingApprovals).toEqual([]);
  });

  it("a retried teardown on a deleted session is idempotent", async () => {
    const orchestrator = createTestOrchestrator();
    await teardown(orchestrator);
    const first = (orchestrator.state as OrchestratorState).sessionDeletedAt;

    expect((await teardown(orchestrator)).status).toBe(200);
    expect((orchestrator.state as OrchestratorState).sessionDeletedAt).toBe(first);
  });

  it("closes sockets that connect after deletion and refuses delegated work", async () => {
    const orchestrator = createTestOrchestrator();
    const early = mockConnection();
    await orchestrator.onConnect(early as any, {} as any);
    expect(early.close).not.toHaveBeenCalled();

    await teardown(orchestrator);
    const late = mockConnection();
    await orchestrator.onConnect(late as any, {} as any);
    expect(late.close).toHaveBeenCalledWith(SESSION_DELETED_CLOSE_CODE, "Session deleted.");

    await expect(
      (orchestrator as any).executeDelegatedTask({ repoUrl: "https://github.com/o/r", task: "t" }, vi.fn(), "call-1"),
    ).rejects.toThrow("Session deleted.");
  });
});

function makeMockEnv() {
    const sessionMap = new Map<string, WebSessionRecord[]>();
    const runsMap = new Map<string, any[]>();
    const approvalsMap = new Map<string, PendingApproval[]>();
    const activeRunsMap = new Map<string, number>();
    const orchestratorStubs = new Map<string, any>();
    const teardownCalls: string[] = [];

    const getStub = (name: string) => {
      if (!orchestratorStubs.has(name)) {
        orchestratorStubs.set(name, {
          name,
          fetch: async (input: RequestInfo | URL | string, init?: RequestInit) => {
            const req =
              typeof input === "string" || input instanceof URL
                ? new Request(input, init)
                : input;
            const url = new URL(req.url);

            if (url.pathname === "/internal/web-sessions") {
              if (req.method === "GET") {
                return Response.json({
                  sessions: (sessionMap.get(name) ?? []).filter((s) => !s.deletingAt),
                });
              }
              if (req.method === "POST") {
                const body = (await req.json()) as { session: WebSessionRecord };
                const list = sessionMap.get(name) ?? [];
                list.push(body.session);
                sessionMap.set(name, list);
                return Response.json({ session: body.session }, { status: 201 });
              }
            }

            const resumeMatch = url.pathname.match(/^\/internal\/web-sessions\/([^/]+)\/resume$/);
            if (resumeMatch && req.method === "POST") {
              const id = decodeURIComponent(resumeMatch[1]!);
              const list = sessionMap.get(name) ?? [];
              const s = list.find((item) => item.id === id);
              if (!s || s.deletingAt) return Response.json({ error: "Session not found." }, { status: 404 });
              s.updatedAt = Date.now();
              return Response.json({ session: s, resumed: true });
            }

            const deletingMatch = url.pathname.match(/^\/internal\/web-sessions\/([^/]+)\/deleting$/);
            if (deletingMatch && req.method === "POST") {
              const id = decodeURIComponent(deletingMatch[1]!);
              const list = sessionMap.get(name) ?? [];
              const s = list.find((item) => item.id === id);
              if (!s) return Response.json({ error: "Session not found." }, { status: 404 });
              const body = (await req.json()) as { deleting?: boolean };
              if (body.deleting === false) {
                s.deletingAt = undefined;
              } else {
                s.deletingAt = s.deletingAt ?? Date.now();
              }
              return Response.json({ session: s });
            }

            const sMatch = url.pathname.match(/^\/internal\/web-sessions\/([^/]+)$/);
            if (sMatch) {
              const id = decodeURIComponent(sMatch[1]!);
              const list = sessionMap.get(name) ?? [];
              const s = list.find((item) => item.id === id);
              const includeDeleting = url.searchParams.get("includeDeleting") === "true";
              if (!s || (s.deletingAt && req.method !== "DELETE" && !includeDeleting)) {
                return Response.json({ error: "Session not found." }, { status: 404 });
              }
              if (req.method === "GET") return Response.json({ session: s });
              if (req.method === "DELETE") {
                sessionMap.set(name, list.filter((item) => item.id !== id));
                return Response.json({ ok: true });
              }
              if (req.method === "PATCH") {
                const patch = (await req.json()) as { name?: string; metadata?: Record<string, unknown> };
                if (patch.name) s.name = patch.name;
                if (patch.metadata !== undefined) s.metadata = patch.metadata;
                return Response.json({ session: s });
              }
            }

            if (url.pathname === "/internal/session-teardown" && req.method === "POST") {
              teardownCalls.push(name);
              const force = url.searchParams.get("force") === "true";
              const activeCount = activeRunsMap.get(name) ?? 0;
              const pendingApprovals = (approvalsMap.get(name) ?? []).filter((a) => a.status === "pending");
              if (!force && (activeCount > 0 || pendingApprovals.length > 0)) {
                return Response.json(
                  { error: "Cannot delete session with active runs or pending approvals.", activeRuns: activeCount, pendingApprovals: pendingApprovals.length },
                  { status: 409 },
                );
              }
              activeRunsMap.set(name, 0);
              for (const a of pendingApprovals) a.status = "rejected";
              return Response.json({ ok: true });
            }

            if (url.pathname.startsWith("/api/runs")) {
              if (req.method === "GET") {
                return Response.json({ runs: runsMap.get(name) ?? [], target: name });
              }
            }

            if (url.pathname === "/api/approvals") {
              if (req.method === "GET") {
                const approvals = (approvalsMap.get(name) ?? []).filter((a) => a.status === "pending");
                const decided = (approvalsMap.get(name) ?? []).filter((a) => a.status !== "pending");
                return Response.json({ approvals, decided });
              }
              if (req.method === "POST") {
                const body = (await req.json()) as { threadKey: string; approvalId: string; approved: boolean };
                const list = approvalsMap.get(name) ?? [];
                const found = list.find((a) => a.approvalId === body.approvalId && a.threadKey === body.threadKey);
                if (!found) {
                  return Response.json({ result: "unknown" });
                }
                found.status = body.approved ? "approved" : "rejected";
                return Response.json({ result: found.status });
              }
            }

            return Response.json({ error: "Not handled in test stub" }, { status: 404 });
          },
        });
      }
      return orchestratorStubs.get(name);
    };

    const env = {
      CodingOrchestrator: {
        get: vi.fn((id: unknown) => getStub(String(id))),
        idFromName: vi.fn((name: string) => name),
      },
      REQUIRE_ACCESS: "1",
      ASSETS: { fetch: vi.fn() },
    } as unknown as Env;

    return { env, sessionMap, runsMap, approvalsMap, activeRunsMap, teardownCalls };
  }

describe("Worker End-to-End: /api/sessions, /api/runs, /api/approvals, and /agents/", () => {

  it("enforces Access authentication on /api/sessions", async () => {
    const { env } = makeMockEnv();
    const unauthedReq = new Request("https://example.com/api/sessions");
    const res = await worker.fetch(unauthedReq, env);
    expect(res.status).toBe(401);
  });

  it("returns JSON 404 for unmatched /api/* instead of falling through to assets", async () => {
    const { env } = makeMockEnv();
    const req = new Request("https://example.com/api/no-such-route", {
      headers: { "CF-Access-Authenticated-User-Email": "tester@example.com" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Not found." });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("creates a named session with bounded metadata; rejects invalid metadata", async () => {
    const { env } = makeMockEnv();

    // Rejects invalid metadata (e.g. nested object / non-primitive)
    const badReq = new Request("https://example.com/api/sessions", {
      method: "POST",
      headers: {
        "CF-Access-Authenticated-User-Email": "alice@example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Bad Session",
        metadata: { nested: { invalid: true } },
      }),
    });
    const badRes = await worker.fetch(badReq, env);
    expect(badRes.status).toBe(400);

    // Creates valid session with bounded metadata
    const goodReq = new Request("https://example.com/api/sessions", {
      method: "POST",
      headers: {
        "CF-Access-Authenticated-User-Email": "alice@example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Good Session",
        metadata: { repo: "ai-intern", branch: "main" },
      }),
    });
    const goodRes = await worker.fetch(goodReq, env);
    expect(goodRes.status).toBe(201);
    const { session } = (await goodRes.json()) as { session: WebSessionRecord };
    expect(session.metadata).toEqual({ repo: "ai-intern", branch: "main" });
  });

  it("returns 400 for malformed non-empty POST JSON; empty body still creates", async () => {
    const { env } = makeMockEnv();
    const headers = {
      "CF-Access-Authenticated-User-Email": "alice@example.com",
      "Content-Type": "application/json",
    };

    const malformed = await worker.fetch(
      new Request("https://example.com/api/sessions", {
        method: "POST",
        headers,
        body: "{not valid json",
      }),
      env,
    );
    expect(malformed.status).toBe(400);

    const empty = await worker.fetch(
      new Request("https://example.com/api/sessions", { method: "POST", headers }),
      env,
    );
    expect(empty.status).toBe(201);
  });

  it("handles approvals aggregation and resolution across web sessions", async () => {
    const { env, sessionMap, approvalsMap } = makeMockEnv();
    const alice = "alice@example.com";

    // Create session in registry
    const sess = createWebSession(alice, { name: "Audit Session" });
    sessionMap.set(alice, [sess]);

    // Queue approval in base session and approval in web session DO
    approvalsMap.set(alice, [
      { approvalId: "app-base", threadKey: alice, status: "pending", createdAt: 100 } as any,
    ]);
    approvalsMap.set(sess.agentName, [
      { approvalId: "app-web", threadKey: sess.agentName, status: "pending", createdAt: 200 } as any,
    ]);

    // GET /api/approvals aggregates both!
    const listReq = new Request("https://example.com/api/approvals", {
      headers: { "CF-Access-Authenticated-User-Email": alice },
    });
    const listRes = await worker.fetch(listReq, env);
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { approvals: PendingApproval[] };
    expect(listData.approvals.map((a) => a.approvalId)).toEqual(["app-base", "app-web"]);

    // POST /api/approvals resolves approval on the web session DO
    const resolveReq = new Request("https://example.com/api/approvals", {
      method: "POST",
      headers: {
        "CF-Access-Authenticated-User-Email": alice,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadKey: sess.agentName,
        approvalId: "app-web",
        approved: true,
      }),
    });
    const resolveRes = await worker.fetch(resolveReq, env);
    expect(resolveRes.status).toBe(200);
    expect(((await resolveRes.json()) as { result: string }).result).toBe("approved");

    // Resolving with an unauthorized or cross-user web session returns 403
    const bobSession = `web:bob@example.com:${mintSessionId()}`;
    const crossReq = new Request("https://example.com/api/approvals", {
      method: "POST",
      headers: {
        "CF-Access-Authenticated-User-Email": alice,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadKey: bobSession,
        approvalId: "app-123",
        approved: true,
      }),
    });
    const crossRes = await worker.fetch(crossReq, env);
    expect(crossRes.status).toBe(403);
  });

  it("checks session registry on /api/runs and WebSocket /agents/ routes (rejects unregistered/deleted UUIDs)", async () => {
    const { env, sessionMap } = makeMockEnv();
    const alice = "alice@example.com";
    const registered = createWebSession(alice, { name: "Real Session" });
    sessionMap.set(alice, [registered]);

    const arbitraryUuid = mintSessionId();

    // 1. /api/runs with registered session -> 200
    const reqRunsReal = new Request(`https://example.com/api/runs?session=${registered.id}`, {
      headers: { "CF-Access-Authenticated-User-Email": alice },
    });
    const resRunsReal = await worker.fetch(reqRunsReal, env);
    expect(resRunsReal.status).toBe(200);

    // 2. /api/runs with arbitrary unregistered session -> 404
    const reqRunsFake = new Request(`https://example.com/api/runs?session=${arbitraryUuid}`, {
      headers: { "CF-Access-Authenticated-User-Email": alice },
    });
    const resRunsFake = await worker.fetch(reqRunsFake, env);
    expect(resRunsFake.status).toBe(404);

    // 3. /agents/ route with registered session -> allowed
    const reqAgentReal = new Request(
      `https://example.com/agents/coding-orchestrator/${registered.agentName}`,
      { headers: { "CF-Access-Authenticated-User-Email": alice } },
    );
    const resAgentReal = await worker.fetch(reqAgentReal, env);
    expect(resAgentReal.status).not.toBe(404);
    expect(resAgentReal.status).not.toBe(403);

    // 4. /agents/ route with arbitrary unregistered session -> 404
    const reqAgentFake = new Request(
      `https://example.com/agents/coding-orchestrator/web:${alice}:${arbitraryUuid}`,
      { headers: { "CF-Access-Authenticated-User-Email": alice } },
    );
    const resAgentFake = await worker.fetch(reqAgentFake, env);
    expect(resAgentFake.status).toBe(404);
  });

  it("404 contract: real session-not-found answers JSON {error:'Session not found.'} so clients can tell it apart from a missing-route 404", async () => {
    const { env } = makeMockEnv();
    const alice = "alice@example.com";
    const headers = { "CF-Access-Authenticated-User-Email": alice };
    const missingId = mintSessionId();

    // POST /api/sessions/:id/resume for a deleted/never-created session
    const resumeRes = await worker.fetch(
      new Request(`https://example.com/api/sessions/${missingId}/resume`, {
        method: "POST",
        headers,
      }),
      env,
    );
    expect(resumeRes.status).toBe(404);
    expect(((await resumeRes.json()) as { error?: string }).error).toBe("Session not found.");

    // GET /api/runs?session=<missing> reports the same distinguishable body
    const runsRes = await worker.fetch(
      new Request(`https://example.com/api/runs?session=${missingId}`, { headers }),
      env,
    );
    expect(runsRes.status).toBe(404);
    expect(((await runsRes.json()) as { error?: string }).error).toBe("Session not found.");

    // Unsupported-route signals stay distinguishable: a path outside the
    // sessions route shape is not a "Session not found." payload.
    const unhandledRes = await worker.fetch(
      new Request("https://example.com/api/sessions/a/b/c", { headers }),
      env,
    );
    const unhandledBody = (await unhandledRes.json().catch(() => ({}))) as { error?: string };
    expect(unhandledBody.error).not.toBe("Session not found.");
  });

  it("enforces safe deletion lifecycle: rejects active sessions with 409, permits force=true", async () => {
    const { env, sessionMap, activeRunsMap, approvalsMap } = makeMockEnv();
    const alice = "alice@example.com";
    const session = createWebSession(alice, { name: "Active Session" });
    sessionMap.set(alice, [session]);

    // Make session have active runs
    activeRunsMap.set(session.agentName, 1);
    approvalsMap.set(session.agentName, [
      { approvalId: "p1", status: "pending", threadKey: session.agentName } as any,
    ]);

    // DELETE without force -> 409 Conflict
    const delNoForce = new Request(`https://example.com/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { "CF-Access-Authenticated-User-Email": alice },
    });
    const resNoForce = await worker.fetch(delNoForce, env);
    expect(resNoForce.status).toBe(409);
    // Ensure session is NOT deleted from registry, and the tombstone was
    // rolled back so the session remains resolvable (no phantom deletions).
    expect(sessionMap.get(alice)?.length).toBe(1);
    const getAfterConflict = await worker.fetch(
      new Request(`https://example.com/api/sessions/${session.id}`, {
        headers: { "CF-Access-Authenticated-User-Email": alice },
      }),
      env,
    );
    expect(getAfterConflict.status).toBe(200);

    // DELETE with force=true -> cleans up and succeeds with 200
    const delForce = new Request(`https://example.com/api/sessions/${session.id}?force=true`, {
      method: "DELETE",
      headers: { "CF-Access-Authenticated-User-Email": alice },
    });
    const resForce = await worker.fetch(delForce, env);
    expect(resForce.status).toBe(200);
    const forceBody = (await resForce.json()) as {
      ok: boolean;
      deleted: string;
      force: boolean;
      teardownFailed?: boolean;
    };
    expect(forceBody.ok).toBe(true);
    expect(forceBody.deleted).toBe(session.id);
    expect(forceBody.force).toBe(true);
    expect(forceBody.teardownFailed).toBeUndefined();
    // Ensure session IS now deleted from registry
    expect(sessionMap.get(alice)?.length).toBe(0);
  });
});

describe("Forged session records cannot steer Worker trust points", () => {
  const alice = "alice@example.com";
  const victim = "victim@example.com";

  // A record that survives the mock registry's naive insert but whose
  // agentName points at another user's DO — the shape a client-side state
  // write could have smuggled in before access became read-only.
  function forgedRecord(owner: string, agentName: string): WebSessionRecord {
    const legit = createWebSession(owner, { name: "Forged" });
    return { ...legit, agentName };
  }

  it("DELETE /api/sessions tears down only the recomputed web:<user>:<id> DO", async () => {
    const { env, sessionMap, teardownCalls } = makeMockEnv();
    const forged = forgedRecord(alice, victim);
    sessionMap.set(alice, [forged]);

    const res = await worker.fetch(
      new Request(`https://example.com/api/sessions/${forged.id}?force=true`, {
        method: "DELETE",
        headers: { "CF-Access-Authenticated-User-Email": alice },
      }),
      env,
    );
    expect(res.status).toBe(200);
    // The victim DO named by the forged agentName was never touched; the
    // teardown went to the deterministic web:alice:<id> instance only.
    expect(teardownCalls).toEqual([`web:${alice}:${forged.id}`]);
    expect(teardownCalls).not.toContain(victim);
    expect(sessionMap.get(alice)?.length).toBe(0);
  });

  it("GET /api/approvals never fans out to a DO named by a forged record", async () => {
    const { env, sessionMap, approvalsMap } = makeMockEnv();
    sessionMap.set(alice, [forgedRecord(alice, victim)]);
    approvalsMap.set(victim, [
      { approvalId: "app-victim", threadKey: victim, status: "pending", createdAt: 100 } as any,
    ]);

    const res = await worker.fetch(
      new Request("https://example.com/api/approvals", {
        headers: { "CF-Access-Authenticated-User-Email": alice },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: PendingApproval[] };
    expect(body.approvals.map((a) => a.approvalId)).not.toContain("app-victim");
  });

  it("POST /api/approvals cannot reach an approval on a DO a forged record names", async () => {
    const { env, sessionMap, approvalsMap } = makeMockEnv();
    sessionMap.set(alice, [forgedRecord(alice, victim)]);
    const pending = {
      approvalId: "app-victim",
      threadKey: victim,
      status: "pending",
      createdAt: 100,
    } as any;
    approvalsMap.set(victim, [pending]);

    const res = await worker.fetch(
      new Request("https://example.com/api/approvals", {
        method: "POST",
        headers: {
          "CF-Access-Authenticated-User-Email": alice,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadKey: victim, approvalId: "app-victim", approved: true }),
      }),
      env,
    );
    // The forged DO name is not in the recomputed fan-out set, so the
    // victim's approval was never probed and stays pending.
    expect(((await res.json()) as { result: string }).result).toBe("unknown");
    expect(pending.status).toBe("pending");
  });

  it("client-sourced state writes are rejected while server writes pass", () => {
    const orchestrator = Object.create(CodingOrchestrator.prototype) as CodingOrchestrator;
    const fakeConnection = { id: "conn-1" } as any;
    expect(() =>
      orchestrator.validateStateChange(
        { runs: [], webSessions: [forgedRecord(alice, victim)] },
        fakeConnection,
      ),
    ).toThrow("Client state writes are not accepted.");
    // Server-sourced writes still pass.
    expect(() =>
      orchestrator.validateStateChange({ runs: [] }, "server"),
    ).not.toThrow();
  });

  it("GET /api/approvals omits integrity-failing records from webSessions", async () => {
    const forged = forgedRecord(alice, victim);
    const orchestrator = Object.create(CodingOrchestrator.prototype) as CodingOrchestrator;
    Object.assign(orchestrator, {
      state: { runs: [], webSessions: [forged], pendingApprovals: [] } as OrchestratorState,
      setState(s: OrchestratorState) {
        Object.assign(this, { state: s });
      },
    });
    Object.defineProperty(orchestrator, "name", { value: alice, configurable: true });

    const res = await orchestrator.onRequest(new Request("https://internal/api/approvals"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webSessions: string[] };
    expect(body.webSessions).not.toContain(victim);
    expect(body.webSessions).toEqual([]);
  });
});
