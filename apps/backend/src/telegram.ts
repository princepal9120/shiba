/**
 * Telegram bot lane.
 *
 * Telegram signs nothing. setWebhook's `secret_token` is echoed on every
 * delivery in `X-Telegram-Bot-Api-Secret-Token`, so that header is the
 * authentication — header-only, never a query parameter
 * (https://core.telegram.org/bots/api#setwebhook).
 *
 * `/shiba <repo-url> <task>` queues a pending approval on the chat's
 * orchestrator (`telegram:{chatId}`) and replies with an inline-keyboard
 * card. The button data is a pointer: only TELEGRAM_APPROVERS user ids may
 * press it, and the orchestrator honors it only while it is still pending.
 *
 * Telegram redelivers on any non-2xx, so an authenticated update is acked
 * at once and the work runs behind `ctx.waitUntil`, deduped on `update_id`.
 */
import {
  buildChatThreadName,
  buildDecisionData,
  chatApprovalText,
  chatTaskChunks,
  createSeenRing,
  decideChatApproval,
  decisionLine,
  parseChatTaskRequest,
  parseDecisionData,
  queueChatRun,
  telegramApi,
  type ResolveOrchestrator,
} from "./chat-lane.js";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist, type ExecutionContextLike } from "./slack-approval.js";
import { timingSafeEqual } from "./slack.js";

export const TELEGRAM_WEBHOOK_PATH = "/api/telegram/webhook";
export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
export const TELEGRAM_USAGE = "Usage: /shiba <github-repo-url> <task>";

const COMMAND = /^\/shiba(?:@\w+)?(?=\s|$)/i;
const HELP = /^\/(?:start|help)(?:@\w+)?(?=\s|$)/i;

const seenUpdates = createSeenRing(1000);

/** Test hook: reset the dedupe ring between tests. */
export function clearSeenTelegramUpdates(): void {
  seenUpdates.clear();
}

interface TelegramUser {
  id?: number;
  username?: string;
  first_name?: string;
}

interface TelegramMessage {
  message_id?: number;
  chat?: { id?: number };
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id?: string;
  from?: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

type TelegramCall = (method: string, body: Record<string, unknown>) => Promise<unknown>;

export interface TelegramDeps {
  /** Bot API call; defaults to api.telegram.org with TELEGRAM_BOT_TOKEN. */
  call?: TelegramCall;
  /** Resolve the chat's orchestrator; defaults to the Agents SDK router. */
  resolveOrchestrator?: ResolveOrchestrator;
  /** Durable check-and-record for update ids. True = already seen. */
  dedupe?: (updateId: string) => Promise<boolean>;
}

function displayName(user: TelegramUser | undefined): string {
  if (user?.username) return `@${user.username}`;
  return user?.first_name || String(user?.id ?? "unknown");
}

async function handleMessage(message: TelegramMessage, env: Env, call: TelegramCall, deps: TelegramDeps): Promise<void> {
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const text = message.text?.trim() ?? "";
  if (typeof chatId !== "number" || typeof messageId !== "number") return;
  const reply = (body: Record<string, unknown>) =>
    call("sendMessage", {
      chat_id: chatId,
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      ...body,
    });
  if (HELP.test(text)) {
    await reply({ text: `${TELEGRAM_USAGE}\nNothing runs until someone on the approver list presses Approve.` });
    return;
  }
  if (!COMMAND.test(text)) return;
  const parsed = parseChatTaskRequest({
    text: text.replace(COMMAND, ""),
    conversationId: String(chatId),
    repoMap: env.TELEGRAM_CHAT_REPOS,
    mapName: "TELEGRAM_CHAT_REPOS",
    usage: TELEGRAM_USAGE,
  });
  if ("error" in parsed) {
    await reply({ text: parsed.error });
    return;
  }
  const queued = await queueChatRun(env, {
    platform: "telegram",
    threadKey: buildChatThreadName("telegram", String(chatId)),
    repoUrl: parsed.repoUrl,
    task: parsed.task,
    userId: String(message.from?.id ?? ""),
    harness: env.TELEGRAM_AGENT_HARNESS ?? env.AGENT_HARNESS,
  }, deps.resolveOrchestrator);
  if ("error" in queued) {
    await reply({ text: `Failed to queue the task. ${queued.error}` });
    return;
  }
  await reply({
    text: chatApprovalText({ ...parsed, approvalId: queued.approvalId, route: queued.route }),
    reply_markup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: buildDecisionData(true, queued.approvalId) },
        { text: "Reject", callback_data: buildDecisionData(false, queued.approvalId) },
      ]],
    },
  });
  // Telegram's message cap is 4096; a task over the card limit posts in full
  // right after the card so Approve never signs off on hidden text.
  for (const chunk of chatTaskChunks(parsed.task, 3900)) {
    await call("sendMessage", { chat_id: chatId, text: chunk });
  }
}

async function handleCallback(query: TelegramCallbackQuery, env: Env, call: TelegramCall, deps: TelegramDeps): Promise<void> {
  const queryId = query.id ?? "";
  if (!queryId) return;
  const answer = (text: string, alert = false) =>
    call("answerCallbackQuery", { callback_query_id: queryId, text, show_alert: alert });
  const decision = parseDecisionData(query.data ?? "");
  const chatId = query.message?.chat?.id;
  if (!decision || typeof chatId !== "number") {
    await answer("This button is not a Shiba approval.", true);
    return;
  }
  // The secret token authenticates Telegram, not the human. Empty list = nobody.
  const userId = String(query.from?.id ?? "");
  if (!isApprover(userId, parseApproverAllowlist(env.TELEGRAM_APPROVERS))) {
    await answer("You are not on the approver list.", true);
    return;
  }
  const result = await decideChatApproval(env, {
    platform: "telegram",
    threadKey: buildChatThreadName("telegram", String(chatId)),
    approvalId: decision.approvalId,
    approved: decision.approved,
    decidedBy: `telegram:${userId}`,
  }, deps.resolveOrchestrator);
  if (!result.ok) {
    await answer(result.error, true);
    return;
  }
  await answer(decision.approved ? "Approved — run starting." : "Rejected — no run started.");
  const messageId = query.message?.message_id;
  if (typeof messageId !== "number") return;
  // No reply_markup: the edit retires the buttons so the card can't be pressed again.
  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `${query.message?.text ?? "Approval"}\n\n${decisionLine(decision.approved, displayName(query.from))}`,
  }).catch((error: unknown) => {
    console.error("Telegram approval card update failed", redactSecrets(String(error)));
  });
}

/**
 * Handle POST /api/telegram/webhook. Returns null for any other path or
 * method so the Worker can fall through to the remaining routes.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
  deps: TelegramDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TELEGRAM_WEBHOOK_PATH || request.method !== "POST") {
    return null;
  }
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!token || !secret) {
    return Response.json(
      { error: "Telegram is not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET." },
      { status: 503 },
    );
  }
  if (!timingSafeEqual(request.headers.get(TELEGRAM_SECRET_HEADER) ?? "", secret)) {
    return Response.json({ error: "Invalid Telegram secret token." }, { status: 401 });
  }
  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return Response.json({ error: "Telegram update is not valid JSON." }, { status: 400 });
  }
  if (typeof update !== "object" || update === null || typeof (update as TelegramUpdate).update_id !== "number") {
    return new Response("", { status: 200 });
  }
  const body = update as TelegramUpdate;
  const key = String(body.update_id);
  if (seenUpdates.has(key)) {
    return new Response("", { status: 200 });
  }
  if (deps.dedupe) {
    try {
      if (await deps.dedupe(key)) {
        seenUpdates.add(key);
        return new Response("", { status: 200 });
      }
    } catch {
      // Dedupe backend down: ack anyway — a duplicate beats a lost update.
    }
  }
  seenUpdates.add(key);
  const call = deps.call ?? ((method: string, payload: Record<string, unknown>) => telegramApi(token, method, payload));
  const work = (body.callback_query
    ? handleCallback(body.callback_query, env, call, deps)
    : body.message
      ? handleMessage(body.message, env, call, deps)
      : Promise.resolve()
  ).catch((error: unknown) => {
    console.error("Telegram update failed", redactSecrets(String(error)));
  });
  if (ctx) {
    ctx.waitUntil(work);
  } else {
    await work;
  }
  return new Response("", { status: 200 });
}
