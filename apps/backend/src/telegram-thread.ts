/**
 * One Telegram chat is one orchestrator conversation.
 *
 * Naming the CodingOrchestrator DO after the chat (`telegram:{chat_id}`)
 * gives each chat its own history, approval state, and run registry —
 * the same contract the Slack thread naming relies on, so approval
 * gating, run registry, concurrency limits, and cancellation all work
 * unchanged.
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";

/** The Telegram path opens a pull request by default, same as Slack. */
export const TELEGRAM_DEFAULT_PUBLISH_PR = true;

/** Telegram-originated runs launch Claude Code unless configured otherwise. */
export const TELEGRAM_DEFAULT_HARNESS = "claude-code";

/**
 * Which coding agent runs Telegram tasks: TELEGRAM_AGENT_HARNESS wins, then
 * the deployment-wide AGENT_HARNESS, then Claude Code — same default family
 * as the Slack coworker surface.
 */
export function resolveTelegramHarness(env: { TELEGRAM_AGENT_HARNESS?: string; AGENT_HARNESS?: string }): string {
  return env.TELEGRAM_AGENT_HARNESS?.trim() || env.AGENT_HARNESS?.trim() || TELEGRAM_DEFAULT_HARNESS;
}

/** Telegram chat ids are integers; group/supergroup ids are negative. */
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;

export function buildTelegramThreadName(chatId: string): string {
  const trimmed = chatId.trim();
  if (!TELEGRAM_CHAT_ID_PATTERN.test(trimmed)) {
    throw new Error(`Cannot name a Telegram conversation: chat_id "${chatId}" is malformed.`);
  }
  return `telegram:${trimmed}`;
}

/** Inverse of buildTelegramThreadName — recovers the chat for post-back. */
export function parseTelegramThreadName(name: string): string | null {
  const match = /^telegram:(-?\d+)$/.exec(name);
  return match?.[1] ?? null;
}

export interface TelegramRunPayload {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  source: "telegram";
  harness?: string;
  channel_id?: string;
  user_id?: string;
}

/** Same queue-body shape as buildSlackRunPayload, keyed to the chat. */
export function buildTelegramRunPayload(input: {
  repoUrl: string;
  task: string;
  baseBranch?: string;
  chatId?: string;
  userId?: string;
  harness?: string;
}): TelegramRunPayload {
  return {
    repoUrl: input.repoUrl,
    task: input.task,
    baseBranch: input.baseBranch ?? "main",
    publishPullRequest: TELEGRAM_DEFAULT_PUBLISH_PR,
    source: "telegram",
    ...(input.harness ? { harness: input.harness } : {}),
    ...(input.chatId ? { channel_id: input.chatId } : {}),
    ...(input.userId ? { user_id: input.userId } : {}),
  };
}

type ByName = (
  namespace: Env["CodingOrchestrator"],
  name: string,
) => Promise<unknown>;

/** Resolve the CodingOrchestrator stub for a Telegram chat. */
export async function getTelegramThreadStub<Stub>(
  env: Env,
  chatId: string,
  byName: ByName = getAgentByName as unknown as ByName,
): Promise<Stub> {
  return (await byName(env.CodingOrchestrator, buildTelegramThreadName(chatId))) as Stub;
}
