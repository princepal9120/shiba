/**
 * Telegram Bot API helpers + webhook verification.
 *
 * Telegram has no request signing: the webhook carries a shared secret in
 * the `X-Telegram-Bot-Api-Secret-Token` header, set via setWebhook's
 * `secret_token` parameter. Constant-time compare, same as Slack's HMAC.
 */
import { timingSafeEqual } from "./slack.js";

const TELEGRAM_API = "https://api.telegram.org";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export interface TelegramMessageInput {
  chatId: string;
  text: string;
  replyMarkup?: TelegramInlineKeyboard;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

async function telegramApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || json.ok !== true) {
    const description = typeof json.description === "string" ? json.description : `Telegram API ${response.status}`;
    throw new Error(description);
  }
  return json;
}

/** sendMessage — the approval card and terminal posts share this one write path. */
export async function postTelegramMessage(token: string, input: TelegramMessageInput): Promise<void> {
  await telegramApi(token, "sendMessage", {
    chat_id: /^-?\d+$/.test(input.chatId) ? Number(input.chatId) : input.chatId,
    text: input.text,
    disable_web_page_preview: true,
    ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
  });
}

/** After a decision the card is rewritten in place so the buttons die with it. */
export async function editTelegramMessage(
  token: string,
  input: { chatId: string; messageId: number; text: string },
): Promise<void> {
  await telegramApi(token, "editMessageText", {
    chat_id: /^-?\d+$/.test(input.chatId) ? Number(input.chatId) : input.chatId,
    message_id: input.messageId,
    text: input.text,
    disable_web_page_preview: true,
  });
}

/** Acknowledge a button press — Telegram shows a spinner until this lands. */
export async function answerTelegramCallback(
  token: string,
  input: { callbackQueryId: string; text?: string },
): Promise<void> {
  await telegramApi(token, "answerCallbackQuery", {
    callback_query_id: input.callbackQueryId,
    ...(input.text ? { text: input.text } : {}),
  });
}

/** The webhook secret arrives as a header, not a signature — compare in constant time. */
export function verifyTelegramSecret(headers: Headers, secret: string): boolean {
  const presented = headers.get(TELEGRAM_SECRET_HEADER) ?? "";
  return presented !== "" && timingSafeEqual(presented, secret);
}
