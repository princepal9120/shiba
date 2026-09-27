/**
 * Chat-lane wire shapes: one conversation is one CodingOrchestrator
 * conversation named `{platform}:{id}` — Telegram group, Discord channel,
 * or a dashboard web session. Only the naming/parse helpers live here;
 * the bot-API plumbing stays in the backend.
 */

export type ChatPlatform = "telegram" | "discord" | "web";

// Telegram group chat ids are negative; Discord ids are numeric snowflakes.
const CONVERSATION_ID = /^-?\d{1,24}$/;
// Web conversation ids are opaque but bounded: letters, digits, dash, and
// underscore only, so a name can never smuggle a second colon.
const WEB_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const THREAD_NAME = /^(telegram|discord|web):(.+)$/;
const DECISION_DATA = /^(approve|reject):([0-9a-f-]{36})$/;

function isValidConversationId(platform: ChatPlatform, id: string): boolean {
  return platform === "web" ? WEB_CONVERSATION_ID.test(id) : CONVERSATION_ID.test(id);
}

export function buildChatThreadName(platform: ChatPlatform, conversationId: string): string {
  const id = conversationId.trim();
  if (!isValidConversationId(platform, id)) {
    throw new Error(`Cannot name a ${platform} conversation: id "${id}" is malformed.`);
  }
  return `${platform}:${id}`;
}

export function parseChatThreadName(name: string): { platform: ChatPlatform; conversationId: string } | null {
  const match = THREAD_NAME.exec(name);
  if (!match) return null;
  const platform = match[1] as ChatPlatform;
  const conversationId = match[2]!;
  if (!isValidConversationId(platform, conversationId)) return null;
  return { platform, conversationId };
}

export interface ChatTaskRequest {
  repoUrl: string;
  task: string;
}

export interface ChatDecision {
  approved: boolean;
  approvalId: string;
}

/** Button payload: a pointer, not a capability. Fits Telegram's 64-byte callback_data. */
export function buildDecisionData(approved: boolean, approvalId: string): string {
  return `${approved ? "approve" : "reject"}:${approvalId}`;
}

export function parseDecisionData(value: string): ChatDecision | null {
  const match = DECISION_DATA.exec(value);
  if (!match) return null;
  return { approved: match[1] === "approve", approvalId: match[2]! };
}
