import { describe, expect, it, vi } from "vitest";
import { handleTelegramWebhook, type TelegramDeps } from "../src/telegram-routes.js";
import { buildTelegramThreadName, parseTelegramThreadName, resolveTelegramHarness } from "../src/telegram-thread.js";

const SECRET = "tg-secret";
const REPO = "https://github.com/owner/repo";

type QueueRun = NonNullable<TelegramDeps["queueRun"]>;
type PostMessage = NonNullable<TelegramDeps["postMessage"]>;
type AnswerCallback = NonNullable<TelegramDeps["answerCallback"]>;
type EditMessage = NonNullable<TelegramDeps["editMessage"]>;
type ResolveOrchestrator = NonNullable<TelegramDeps["resolveOrchestrator"]>;

function env(overrides: Record<string, unknown> = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "tg-token",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    ...overrides,
  } as never;
}

function request(body: unknown, secret: string | null = SECRET): Request {
  return new Request("https://internal/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret !== null ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

function dm(text = `fix the tests ${REPO}`, overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      text,
      chat: { id: 1234, type: "private" },
      from: { id: 42, username: "prince" },
      ...overrides,
    },
  };
}

function groupMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    update_id: 2,
    message: {
      message_id: 11,
      text,
      chat: { id: -987, type: "supergroup" },
      from: { id: 42 },
      ...overrides,
    },
  };
}

function callback(data: string, fromId = 42) {
  return {
    update_id: 3,
    callback_query: {
      id: "cbq1",
      data,
      from: { id: fromId, username: "prince" },
      message: { message_id: 12, chat: { id: 1234, type: "private" } },
    },
  };
}

describe("telegram webhook auth", () => {
  it("503s when TELEGRAM_WEBHOOK_SECRET is unset", async () => {
    const response = await handleTelegramWebhook(request(dm()), env({ TELEGRAM_WEBHOOK_SECRET: undefined }));
    expect(response?.status).toBe(503);
  });

  it("401s on a wrong or missing secret token", async () => {
    expect((await handleTelegramWebhook(request(dm(), "wrong"), env()))?.status).toBe(401);
    expect((await handleTelegramWebhook(request(dm(), null), env()))?.status).toBe(401);
  });

  it("ignores non-telegram paths and methods", async () => {
    expect(
      await handleTelegramWebhook(new Request("https://internal/api/other", { method: "POST" }), env()),
    ).toBeNull();
    expect(
      await handleTelegramWebhook(new Request("https://internal/api/telegram/webhook"), env()),
    ).toBeNull();
  });
});

describe("telegram message dispatch", () => {
  it("queues a run and sends an inline-keyboard approval card from a DM", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_t1" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    const response = await handleTelegramWebhook(request(dm()), env(), { queueRun, postMessage });
    expect(response?.status).toBe(200);
    expect(queueRun).toHaveBeenCalledOnce();
    const queued = queueRun.mock.calls.at(0)?.at(0);
    expect(queued).toMatchObject({
      threadKey: "telegram:1234",
      repoUrl: REPO,
      task: "fix the tests",
      chatId: "1234",
      userId: "42",
      harness: "claude-code",
    });
    const posted = postMessage.mock.calls.at(0)?.at(0);
    expect(posted?.text).toContain("on it");
    expect(posted?.text).toContain("claude code");
    expect(posted?.replyMarkup?.inline_keyboard).toEqual([[
      { text: "Approve", callback_data: "a:appr_t1" },
      { text: "Reject", callback_data: "r:appr_t1" },
    ]]);
  });

  it("asks for a repo when the message has no GitHub URL", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_x" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleTelegramWebhook(request(dm("fix this please")), env(), { queueRun, postMessage });
    expect(queueRun).not.toHaveBeenCalled();
    const posted = postMessage.mock.calls.at(0)?.at(0);
    expect(posted?.text).toBeTruthy();
  });

  it("ignores group messages without a bot mention; queues on @mention", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_g" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    const envWithBot = env({ TELEGRAM_BOT_USERNAME: "shiba_bot" });
    await handleTelegramWebhook(request(groupMessage(`fix it ${REPO}`)), envWithBot, { queueRun, postMessage });
    expect(queueRun).not.toHaveBeenCalled();
    await handleTelegramWebhook(request(groupMessage(`@shiba_bot fix it ${REPO}`)), envWithBot, { queueRun, postMessage });
    expect(queueRun).toHaveBeenCalledOnce();
    expect(queueRun.mock.calls.at(0)?.at(0)?.threadKey).toBe("telegram:-987");
  });

  it("does nothing without a bot token", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_x" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    const response = await handleTelegramWebhook(request(dm()), env({ TELEGRAM_BOT_TOKEN: "" }), { queueRun });
    expect(response?.status).toBe(200);
    expect(queueRun).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("still acks 200 when the queue fails and tells the chat", async () => {
    const queueRun = vi.fn<QueueRun>(async () => { throw new Error("boom"); });
    const postMessage = vi.fn<PostMessage>(async () => {});
    const response = await handleTelegramWebhook(request(dm()), env(), { queueRun, postMessage });
    expect(response?.status).toBe(200);
    expect(postMessage).toHaveBeenCalledOnce();
  });
});

describe("telegram approval callbacks", () => {
  it("dispatches an approver's decision to the chat's orchestrator", async () => {
    const answerCallback = vi.fn<AnswerCallback>(async () => {});
    const editMessage = vi.fn<EditMessage>(async () => {});
    const stubFetch = vi.fn(async (_request: Request) => Response.json({ result: "approved" }));
    const resolveOrchestrator = vi.fn<ResolveOrchestrator>(async () => ({ fetch: stubFetch }));
    const response = await handleTelegramWebhook(
      request(callback("a:appr_t1")),
      env({ TELEGRAM_APPROVERS: "42" }),
      { answerCallback, editMessage, resolveOrchestrator, postMessage: async () => {} },
    );
    expect(response?.status).toBe(200);
    expect(resolveOrchestrator).toHaveBeenCalledWith("telegram:1234");
    const approvalRequest = stubFetch.mock.calls[0]![0] as Request;
    expect(JSON.parse(await approvalRequest.text())).toMatchObject({
      threadKey: "telegram:1234",
      approvalId: "appr_t1",
      approved: true,
      decidedBy: "@prince",
      source: "telegram",
    });
    expect(answerCallback).toHaveBeenCalledWith({ callbackQueryId: "cbq1", text: "approved" });
    expect(editMessage.mock.calls.at(0)?.at(0)?.text).toContain("approved by @prince");
  });

  it("refuses a non-approver without touching the orchestrator", async () => {
    const answerCallback = vi.fn<AnswerCallback>(async () => {});
    const editMessage = vi.fn<EditMessage>(async () => {});
    const resolveOrchestrator = vi.fn<ResolveOrchestrator>(async () => ({ fetch: async () => Response.json({}) }));
    await handleTelegramWebhook(
      request(callback("a:appr_t1", 99)),
      env({ TELEGRAM_APPROVERS: "42" }),
      { answerCallback, editMessage, resolveOrchestrator, postMessage: async () => {} },
    );
    expect(answerCallback.mock.calls.at(0)?.at(0)?.text).toContain("not on the approver list");
    expect(resolveOrchestrator).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("rejects with an empty approver list — never 'anyone'", async () => {
    const answerCallback = vi.fn<AnswerCallback>(async () => {});
    const resolveOrchestrator = vi.fn<ResolveOrchestrator>(async () => ({ fetch: async () => Response.json({}) }));
    await handleTelegramWebhook(
      request(callback("a:appr_t1")),
      env({ TELEGRAM_APPROVERS: "" }),
      { answerCallback, resolveOrchestrator, postMessage: async () => {}, editMessage: async () => {} },
    );
    expect(resolveOrchestrator).not.toHaveBeenCalled();
  });
});

describe("telegram thread naming + harness resolution", () => {
  it("round-trips chat ids including negative group ids", () => {
    expect(buildTelegramThreadName("1234")).toBe("telegram:1234");
    expect(buildTelegramThreadName("-987")).toBe("telegram:-987");
    expect(parseTelegramThreadName("telegram:-987")).toBe("-987");
    expect(parseTelegramThreadName("slack:T:C:1.0")).toBeNull();
    expect(parseTelegramThreadName("default")).toBeNull();
    expect(() => buildTelegramThreadName("not-a-number")).toThrow();
  });

  it("prefers TELEGRAM_AGENT_HARNESS, then AGENT_HARNESS, then claude-code", () => {
    expect(resolveTelegramHarness({ TELEGRAM_AGENT_HARNESS: "codex", AGENT_HARNESS: "opencode" })).toBe("codex");
    expect(resolveTelegramHarness({ AGENT_HARNESS: "opencode" })).toBe("opencode");
    expect(resolveTelegramHarness({})).toBe("claude-code");
  });
});
