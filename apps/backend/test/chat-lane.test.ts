import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents/routing";
import {
  buildChatThreadName,
  buildDecisionData,
  chatApprovalText,
  createSeenRing,
  decideChatApproval,
  decisionLine,
  parseChatTaskRequest,
  parseChatThreadName,
  parseDecisionData,
  postToChatThread,
  queueChatRun,
  telegramApi,
  type OrchestratorStub,
  type ResolveOrchestrator,
} from "../src/chat-lane.js";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));

const REPO = "https://github.com/owner/repo";
const APPROVAL_ID = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
const USAGE = "Usage: /shiba <repo> <task>";

function env(overrides: Record<string, unknown> = {}) {
  return { ...overrides } as never;
}

/** Orchestrator stub whose fetch records the parsed request body. */
function fakeOrchestrator(response: { status?: number; body: unknown }) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const stub: OrchestratorStub = {
    fetch: async (request: Request) => {
      requests.push({
        url: request.url,
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json(response.body, { status: response.status ?? 200 });
    },
  };
  const resolve: ResolveOrchestrator = async () => stub;
  return { requests, resolve };
}

describe("buildChatThreadName / parseChatThreadName", () => {
  it("round-trips a positive conversation id", () => {
    const name = buildChatThreadName("telegram", "12345");
    expect(name).toBe("telegram:12345");
    expect(parseChatThreadName(name)).toEqual({ platform: "telegram", conversationId: "12345" });
  });

  it("round-trips a negative Telegram group id", () => {
    const name = buildChatThreadName("telegram", "-100987");
    expect(parseChatThreadName(name)).toEqual({ platform: "telegram", conversationId: "-100987" });
  });

  it("round-trips a Discord snowflake", () => {
    const name = buildChatThreadName("discord", "777777777777777777");
    expect(parseChatThreadName(name)).toEqual({ platform: "discord", conversationId: "777777777777777777" });
  });

  it("trims whitespace around the id", () => {
    expect(buildChatThreadName("discord", "  42  ")).toBe("discord:42");
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "abc", "12x", "telegram:5", "-", "1234567890123456789012345"]) {
      expect(() => buildChatThreadName("telegram", bad)).toThrow(/malformed/);
    }
  });

  it("returns null for names that are not chat threads", () => {
    expect(parseChatThreadName("slack:T1:C1:123.4")).toBeNull();
    expect(parseChatThreadName("email:inbox-1")).toBeNull();
    expect(parseChatThreadName("telegram:")).toBeNull();
    expect(parseChatThreadName("telegram:123junk")).toBeNull();
    expect(parseChatThreadName("discord:1234567890123456789012345")).toBeNull();
  });
});

describe("parseChatTaskRequest", () => {
  it("takes the repo from the first GitHub URL in the text", () => {
    const parsed = parseChatTaskRequest({
      text: `fix the login bug ${REPO}`,
      conversationId: "1",
      mapName: "MAP",
      usage: USAGE,
    });
    expect(parsed).toEqual({ repoUrl: REPO, task: "fix the login bug" });
  });

  it("keeps working when the URL is followed by more text", () => {
    const parsed = parseChatTaskRequest({
      text: `${REPO} update the readme, please`,
      conversationId: "1",
      mapName: "MAP",
      usage: USAGE,
    });
    expect(parsed).toEqual({ repoUrl: REPO, task: "update the readme, please" });
  });

  it("falls back to the repo map when the text has no URL", () => {
    const parsed = parseChatTaskRequest({
      text: "fix this",
      conversationId: "-100",
      repoMap: JSON.stringify({ "-100": REPO }),
      mapName: "TELEGRAM_CHAT_REPOS",
      usage: USAGE,
    });
    expect(parsed).toEqual({ repoUrl: REPO, task: "fix this" });
  });

  it("a URL in the text wins over the repo map", () => {
    const other = "https://github.com/other/repo";
    const parsed = parseChatTaskRequest({
      text: `ship it ${REPO}`,
      conversationId: "-100",
      repoMap: JSON.stringify({ "-100": other }),
      mapName: "MAP",
      usage: USAGE,
    });
    expect(parsed).toEqual({ repoUrl: REPO, task: "ship it" });
  });

  it("errors with usage when neither text nor map provide a repo", () => {
    const parsed = parseChatTaskRequest({
      text: "fix this",
      conversationId: "99",
      repoMap: JSON.stringify({ "-100": REPO }),
      mapName: "TELEGRAM_CHAT_REPOS",
      usage: USAGE,
    });
    expect("error" in parsed && parsed.error).toContain("TELEGRAM_CHAT_REPOS");
    expect("error" in parsed && parsed.error).toContain(USAGE);
  });

  it("errors when the repo map is invalid JSON", () => {
    const parsed = parseChatTaskRequest({
      text: "fix this",
      conversationId: "-100",
      repoMap: "not-json{",
      mapName: "MAP",
      usage: USAGE,
    });
    expect("error" in parsed && parsed.error).toContain("No repository");
  });

  it("errors when the task is empty after the URL is removed", () => {
    const parsed = parseChatTaskRequest({
      text: REPO,
      conversationId: "1",
      mapName: "MAP",
      usage: USAGE,
    });
    expect("error" in parsed && parsed.error).toContain("Describe the task");
    expect("error" in parsed && parsed.error).toContain(USAGE);
  });
});

describe("buildDecisionData / parseDecisionData", () => {
  it("round-trips approve and reject", () => {
    expect(parseDecisionData(buildDecisionData(true, APPROVAL_ID))).toEqual({
      approved: true,
      approvalId: APPROVAL_ID,
    });
    expect(parseDecisionData(buildDecisionData(false, APPROVAL_ID))).toEqual({
      approved: false,
      approvalId: APPROVAL_ID,
    });
  });

  it("stays inside Telegram's 64-byte callback_data limit", () => {
    expect(buildDecisionData(true, crypto.randomUUID()).length).toBeLessThanOrEqual(64);
  });

  it("returns null for malformed payloads", () => {
    for (const bad of [
      "",
      "approve:",
      `approve:${APPROVAL_ID.slice(0, -1)}`,
      `maybe:${APPROVAL_ID}`,
      `approve:${APPROVAL_ID.toUpperCase()}`,
      `approve:${APPROVAL_ID}:extra`,
      "approve:not-a-uuid-at-all-nor-close!!",
    ]) {
      expect(parseDecisionData(bad)).toBeNull();
    }
  });
});

describe("chatApprovalText / decisionLine", () => {
  it("renders repo, task and the approval pointer", () => {
    const text = chatApprovalText({ repoUrl: REPO, task: "fix it", approvalId: APPROVAL_ID });
    expect(text).toContain(REPO);
    expect(text).toContain("fix it");
    expect(text).toContain(APPROVAL_ID);
  });

  it("truncates a task past the card limit and points at the dashboard", () => {
    const task = "x".repeat(2000);
    const text = chatApprovalText({ repoUrl: REPO, task, approvalId: APPROVAL_ID });
    expect(text).toContain("500 more chars");
    expect(text).toContain("dashboard");
    expect(text).not.toContain("x".repeat(1501));
  });

  it("does not truncate a task at the limit", () => {
    const task = "y".repeat(1500);
    const text = chatApprovalText({ repoUrl: REPO, task, approvalId: APPROVAL_ID });
    expect(text).not.toContain("more chars");
    expect(text).toContain(task);
  });

  it("renders the approve and reject decision lines", () => {
    expect(decisionLine(true, "@alice")).toBe("Approved by @alice — run starting.");
    expect(decisionLine(false, "<@42>")).toBe("Rejected by <@42> — no run started.");
  });
});

describe("queueChatRun", () => {
  it("uses the default resolver with the already-prefixed thread key", async () => {
    const stub = fakeOrchestrator({ body: { approvalId: APPROVAL_ID } });
    vi.mocked(getAgentByName).mockResolvedValue(stub.resolve("telegram:123") as never);
    const result = await queueChatRun(env({ CodingOrchestrator: {} }), {
      platform: "telegram",
      threadKey: "telegram:123",
      repoUrl: REPO,
      task: "fix the bug",
      userId: "42",
    });
    expect(result).toEqual({ approvalId: APPROVAL_ID });
    expect(getAgentByName).toHaveBeenCalledWith({}, "telegram:123");
  });

  const input = {
    platform: "telegram" as const,
    threadKey: "telegram:-100",
    repoUrl: REPO,
    task: "fix it",
    userId: "42",
  };

  it("posts the run and returns the approvalId", async () => {
    const { requests, resolve } = fakeOrchestrator({ body: { ok: true, approvalId: APPROVAL_ID } });
    const result = await queueChatRun(env(), input, resolve);
    expect(result).toEqual({ approvalId: APPROVAL_ID });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://internal/api/runs");
    expect(requests[0]!.body).toMatchObject({
      repoUrl: REPO,
      task: "fix it",
      baseBranch: "main",
      publishPullRequest: true,
      threadKey: "telegram:-100",
      source: "telegram",
      user_id: "42",
    });
  });

  it("omits user_id when the caller has no user id", async () => {
    const { requests, resolve } = fakeOrchestrator({ body: { ok: true, approvalId: APPROVAL_ID } });
    await queueChatRun(env(), { ...input, userId: "" }, resolve);
    expect(requests[0]!.body).not.toHaveProperty("user_id");
  });

  it("surfaces the orchestrator's error body on a non-2xx", async () => {
    const { resolve } = fakeOrchestrator({ status: 500, body: { error: "GITHUB_TOKEN is not set" } });
    const result = await queueChatRun(env(), input, resolve);
    expect(result).toEqual({ error: "GITHUB_TOKEN is not set" });
  });

  it("returns a retry hint when a 2xx response has no approvalId", async () => {
    const { resolve } = fakeOrchestrator({ body: { ok: true } });
    const result = await queueChatRun(env(), input, resolve);
    expect(result).toEqual({ error: "Try again in a moment." });
  });

  it("returns a retry hint when the body is not JSON", async () => {
    const stub: OrchestratorStub = { fetch: async () => new Response("oops", { status: 200 }) };
    const result = await queueChatRun(env(), input, async () => stub);
    expect(result).toEqual({ error: "Try again in a moment." });
  });

  it("reports unreachable when the resolver throws", async () => {
    const result = await queueChatRun(env(), input, async () => {
      throw new Error("no DO");
    });
    expect(result).toEqual({ error: "The orchestrator is unreachable." });
  });

  it("reports unreachable when the stub fetch throws", async () => {
    const stub: OrchestratorStub = {
      fetch: async () => {
        throw new Error("socket closed");
      },
    };
    const result = await queueChatRun(env(), input, async () => stub);
    expect(result).toEqual({ error: "The orchestrator is unreachable." });
  });
});

describe("decideChatApproval", () => {
  const input = {
    platform: "discord" as const,
    threadKey: "discord:777",
    approvalId: APPROVAL_ID,
    approved: true,
    decidedBy: "discord:42",
  };

  it("posts the decision and resolves on an approved result", async () => {
    const { requests, resolve } = fakeOrchestrator({ body: { result: "approved" } });
    const result = await decideChatApproval(env(), input, resolve);
    expect(result).toEqual({ ok: true });
    expect(requests[0]!.url).toBe("https://internal/api/approvals");
    expect(requests[0]!.body).toEqual({
      threadKey: "discord:777",
      approvalId: APPROVAL_ID,
      approved: true,
      decidedBy: "discord:42",
      source: "discord",
    });
  });

  it("resolves on a rejected result", async () => {
    const { resolve } = fakeOrchestrator({ body: { result: "rejected" } });
    const result = await decideChatApproval(env(), { ...input, approved: false }, resolve);
    expect(result).toEqual({ ok: true });
  });

  it("reports an already-resolved pointer when the result is unknown", async () => {
    const { resolve } = fakeOrchestrator({ body: { result: "unknown" } });
    const result = await decideChatApproval(env(), input, resolve);
    expect(result).toEqual({
      ok: false,
      error: "This approval is already resolved or expired — nothing to do.",
    });
  });

  it("surfaces the orchestrator's error body on a non-2xx", async () => {
    const { resolve } = fakeOrchestrator({ status: 400, body: { error: "bad pointer" } });
    const result = await decideChatApproval(env(), input, resolve);
    expect(result).toEqual({ ok: false, error: "bad pointer" });
  });

  it("names the status when a non-2xx has no error body", async () => {
    const { resolve } = fakeOrchestrator({ status: 503, body: {} });
    const result = await decideChatApproval(env(), input, resolve);
    expect(result).toEqual({ ok: false, error: "The decision could not be recorded (503)." });
  });

  it("reports unreachable when the stub fetch throws", async () => {
    const stub: OrchestratorStub = {
      fetch: async () => {
        throw new Error("down");
      },
    };
    const result = await decideChatApproval(env(), input, async () => stub);
    expect(result).toEqual({ ok: false, error: "The orchestrator is unreachable — nothing was recorded." });
  });
});

describe("createSeenRing", () => {
  it("remembers added keys", () => {
    const ring = createSeenRing(3);
    ring.add("a");
    expect(ring.has("a")).toBe(true);
    expect(ring.has("b")).toBe(false);
  });

  it("evicts the oldest key once over capacity", () => {
    const ring = createSeenRing(2);
    ring.add("a");
    ring.add("b");
    ring.add("c");
    expect(ring.has("a")).toBe(false);
    expect(ring.has("b")).toBe(true);
    expect(ring.has("c")).toBe(true);
  });

  it("clear() empties the ring", () => {
    const ring = createSeenRing(2);
    ring.add("a");
    ring.clear();
    expect(ring.has("a")).toBe(false);
  });
});

describe("telegramApi", () => {
  it("posts to the bot endpoint with the token in the path", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ ok: true, result: {} });
    }));
    try {
      const json = await telegramApi("tok123", "sendMessage", { chat_id: 1, text: "hi" });
      expect(json.ok).toBe(true);
      expect(requests[0]!.url).toBe("https://api.telegram.org/bottok123/sendMessage");
      expect(requests[0]!.method).toBe("POST");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws the Telegram description on an ok:false body, never the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ ok: false, description: "chat not found" }, { status: 400 }),
    ));
    try {
      await expect(telegramApi("secret-tok", "sendMessage", {})).rejects.toThrow(
        "Telegram sendMessage failed (400): chat not found",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("dns");
    }));
    try {
      await expect(telegramApi("secret-tok", "getMe", {})).rejects.toThrow(
        "Telegram getMe request failed.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("postToChatThread", () => {
  it("returns null for names that are not chat threads", () => {
    expect(postToChatThread(env(), "slack:T1:C1:1", "hi")).toBeNull();
  });

  it("returns null when the lane has no bot token", () => {
    expect(postToChatThread(env(), "telegram:1", "hi")).toBeNull();
    expect(postToChatThread(env({ TELEGRAM_BOT_TOKEN: "  " }), "telegram:1", "hi")).toBeNull();
    expect(postToChatThread(env(), "discord:1", "hi")).toBeNull();
  });

  it("posts a Telegram message capped at 4000 chars", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    }));
    try {
      const posted = postToChatThread(env({ TELEGRAM_BOT_TOKEN: "t" }), "telegram:-100", "z".repeat(5000));
      expect(posted).not.toBeNull();
      await posted;
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.chat_id).toBe("-100");
      expect(bodies[0]!.text).toHaveLength(4000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

});
