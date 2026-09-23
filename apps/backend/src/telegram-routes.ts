/**
 * Telegram webhook route (POST /api/telegram/webhook).
 *
 * Telegram authenticates its webhook with a shared secret in the
 * X-Telegram-Bot-Api-Secret-Token header (set at setWebhook time) — there
 * is no body signature like Slack's. A verified update proves it came
 * from Telegram, not who sent it, so button presses are authorized
 * separately against TELEGRAM_APPROVERS (comma-separated Telegram user
 * ids; unset = nobody can approve).
 *
 * Every verified update acks 200 — including refusals and errors — so
 * Telegram never retries and double-queues a run.
 */
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { parseSlackCommand, ORCHESTRATOR_NAME } from "./slack-routes.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import {
  slackAck,
  slackAskForRepo,
  slackAskForTask,
  slackQueueFailed,
} from "./slack-persona.js";
import {
  answerTelegramCallback,
  editTelegramMessage,
  postTelegramMessage,
  verifyTelegramSecret,
} from "./telegram.js";
import { missingGithubTokenWarning } from "./slack-thread.js";
import {
  buildTelegramRunPayload,
  buildTelegramThreadName,
  getTelegramThreadStub,
  resolveTelegramHarness,
} from "./telegram-thread.js";

export const TELEGRAM_WEBHOOK_PATH = "/api/telegram/webhook";

interface TelegramUser {
  id?: number;
  username?: string;
}

interface TelegramChat {
  id?: number;
  type?: string;
}

interface TelegramMessage {
  message_id?: number;
  text?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
}

interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  from?: TelegramUser;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramDeps {
  /** Queues the run on the chat's orchestrator DO. */
  queueRun?: (input: {
    threadKey: string;
    repoUrl: string;
    task: string;
    chatId: string;
    userId: string;
    harness: string;
  }) => Promise<{ approvalId: string }>;
  postMessage?: (input: {
    chatId: string;
    text: string;
    replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  }) => Promise<void>;
  answerCallback?: (input: { callbackQueryId: string; text?: string }) => Promise<void>;
  editMessage?: (input: { chatId: string; messageId: number; text: string }) => Promise<void>;
  /** Resolve the DO that owns the approval pointer. */
  resolveOrchestrator?: (threadKey: string) => Promise<{ fetch: (request: Request) => Promise<Response> }>;
}

/** Strip the bot's @mention so the rest parses like the slash command. */
function stripBotMention(text: string, botUsername: string): string {
  return text.replace(new RegExp(`@${botUsername}\\b`, "gi"), " ").replace(/\s+/g, " ").trim();
}

function messageForBot(message: TelegramMessage, botUsername: string): string | null {
  const text = message.text ?? "";
  const chatType = message.chat?.type ?? "";
  if (chatType === "private") return text;
  if ((chatType === "group" || chatType === "supergroup") && botUsername !== "" &&
      new RegExp(`@${botUsername}\\b`, "i").test(text)) {
    return stripBotMention(text, botUsername);
  }
  return null;
}

async function handleTelegramMessage(
  message: TelegramMessage,
  env: Env,
  deps: Required<Pick<TelegramDeps, "postMessage" | "queueRun">>,
): Promise<void> {
  const chatId = String(message.chat?.id ?? "");
  const userId = String(message.from?.id ?? "");
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const botUsername = (env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "").trim();
  if (chatId === "" || token === "") return;
  const text = messageForBot(message, botUsername);
  if (text === null) return;

  let parsed: { repoUrl: string; task: string };
  try {
    parsed = parseSlackCommand(text);
  } catch (error) {
    // Mirror the Slack asks: no repo → ask for one, no task → ask for that.
    const askForTask = error instanceof Error && error.message.includes("Describe the task");
    await deps.postMessage({ chatId, text: askForTask ? slackAskForTask() : slackAskForRepo() });
    return;
  }

  const harness = resolveTelegramHarness(env);
  const threadKey = buildTelegramThreadName(chatId);
  const { approvalId } = await deps.queueRun({
    threadKey,
    repoUrl: parsed.repoUrl,
    task: parsed.task,
    chatId,
    userId,
    harness,
  });
  const warning = missingGithubTokenWarning(env);
  const cardText =
    `Approval requested\nRepo: ${parsed.repoUrl}\nTask: ${parsed.task}\nAgent: ${harness}` +
    (warning ? `\n\n${warning}` : "");
  await deps.postMessage({
    chatId,
    text: `${slackAck({ repoUrl: parsed.repoUrl, harness })}\n\n${cardText}`,
    replyMarkup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: `a:${approvalId}` },
        { text: "Reject", callback_data: `r:${approvalId}` },
      ]],
    },
  });
}

async function handleTelegramCallback(
  query: TelegramCallbackQuery,
  env: Env,
  deps: Required<Pick<TelegramDeps, "answerCallback" | "editMessage" | "resolveOrchestrator">>,
): Promise<void> {
  const queryId = query.id ?? "";
  const chatId = String(query.message?.chat?.id ?? "");
  const messageId = query.message?.message_id ?? 0;
  const userId = String(query.from?.id ?? "");
  const decidedBy = query.from?.username ? `@${query.from.username}` : `tg:${userId}`;
  if (queryId === "" || chatId === "" || messageId === 0) return;

  const approvers = parseApproverAllowlist(env.TELEGRAM_APPROVERS);
  if (!isApprover(userId, approvers)) {
    await deps.answerCallback({ callbackQueryId: queryId, text: "You are not on the approver list." });
    return;
  }

  const data = query.data ?? "";
  const match = /^([ar]):(.+)$/.exec(data);
  if (!match) {
    await deps.answerCallback({ callbackQueryId: queryId });
    return;
  }
  const approved = match[1] === "a";
  const approvalId = match[2]!;
  const threadKey = buildTelegramThreadName(chatId);
  const stub = await deps.resolveOrchestrator(threadKey);
  const response = await stub.fetch(
    new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadKey,
        approvalId,
        approved,
        decidedBy,
        source: "telegram",
      }),
    }),
  );
  if (!response.ok) {
    await deps.answerCallback({ callbackQueryId: queryId, text: "The decision could not be recorded." });
    return;
  }
  await deps.answerCallback({ callbackQueryId: queryId, text: approved ? "approved" : "rejected" });
  await deps.editMessage({
    chatId,
    messageId,
    text: approved
      ? `approved by ${decidedBy} — starting the run.`
      : `rejected by ${decidedBy} — nothing will run.`,
  });
}

/**
 * Handle POST /api/telegram/webhook. Returns null for other paths so the
 * worker falls through. After auth, every outcome is a 200 — the ack is
 * the contract, not the work.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  deps: TelegramDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TELEGRAM_WEBHOOK_PATH || request.method !== "POST") {
    return null;
  }
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!secret) {
    return Response.json(
      { error: "Telegram is not configured: set the TELEGRAM_WEBHOOK_SECRET secret." },
      { status: 503 },
    );
  }
  if (!verifyTelegramSecret(request.headers, secret)) {
    return Response.json({ error: "Invalid Telegram webhook secret." }, { status: 401 });
  }
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return Response.json({ error: "Update body is not valid JSON." }, { status: 400 });
  }

  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const postMessage = deps.postMessage ??
    (token ? (input: Parameters<NonNullable<TelegramDeps["postMessage"]>>[0]) =>
      postTelegramMessage(token, input) : undefined);
  if (!postMessage) {
    // No bot token: nothing can be sent back, so nothing is queued.
    return Response.json({ ok: true });
  }
  const queueRun = deps.queueRun ??
    (async (input) => {
      const stub = await getTelegramThreadStub<{ fetch: (request: Request) => Promise<Response> }>(env, input.chatId);
      const payload = buildTelegramRunPayload({
        repoUrl: input.repoUrl,
        task: input.task,
        chatId: input.chatId,
        userId: input.userId,
        harness: input.harness,
      });
      const queued = await stub.fetch(
        new Request("https://internal/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, threadKey: input.threadKey }),
        }),
      );
      if (!queued.ok) throw new Error(`Queue failed (${queued.status}).`);
      const queuedBody = (await queued.json().catch(() => ({}))) as { approvalId?: string };
      if (!queuedBody.approvalId) throw new Error("Orchestrator did not return an approval id.");
      return { approvalId: queuedBody.approvalId };
    });
  const answerCallback = deps.answerCallback ??
    (token ? (input: { callbackQueryId: string; text?: string }) =>
      answerTelegramCallback(token, input) : undefined);
  const editMessage = deps.editMessage ??
    (token ? (input: { chatId: string; messageId: number; text: string }) =>
      editTelegramMessage(token, input) : undefined);
  const resolveOrchestrator = deps.resolveOrchestrator ??
    ((threadKey: string) => getTelegramThreadStub(env, threadKey || ORCHESTRATOR_NAME));

  try {
    if (update.message) {
      await handleTelegramMessage(update.message, env, { postMessage, queueRun });
    } else if (update.callback_query && answerCallback && editMessage) {
      await handleTelegramCallback(update.callback_query, env, { answerCallback, editMessage, resolveOrchestrator });
    }
  } catch (error) {
    // The ack is the contract: log the dispatch failure, still 200 so
    // Telegram never retries into a duplicate run.
    console.error("Telegram webhook dispatch failed", redactSecrets(String(error)));
    if (update.message) {
      const chatId = String(update.message.chat?.id ?? "");
      if (chatId !== "") {
        await postMessage({ chatId, text: slackQueueFailed() }).catch(() => {});
      }
    }
  }
  return Response.json({ ok: true });
}
