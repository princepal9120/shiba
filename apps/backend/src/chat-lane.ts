/**
 * Shared plumbing for the Telegram and Discord lanes. One Telegram chat or
 * Discord channel is one CodingOrchestrator conversation named
 * `{platform}:{id}`, so queueing, approval, and result post-back reuse the
 * DO paths the Slack lane already uses. Every request only queues a pending
 * approval; nothing here starts a container.
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { extractGitHubRepoUrl, parseChannelRepoMap } from "./slack-context.js";

export type ChatPlatform = "telegram" | "discord";

export const TELEGRAM_API = "https://api.telegram.org";
export const DISCORD_API = "https://discord.com/api/v10";

/** Empty allow-list: task text echoed into a message can never ping anyone. */
export const NO_MENTIONS = { parse: [] as string[] };

// Telegram group chat ids are negative; Discord ids are numeric snowflakes.
const CONVERSATION_ID = /^-?\d{1,24}$/;
const THREAD_NAME = /^(telegram|discord):(-?\d{1,24})$/;
const DECISION_DATA = /^(approve|reject):([0-9a-f-]{36})$/;

export function buildChatThreadName(platform: ChatPlatform, conversationId: string): string {
  const id = conversationId.trim();
  if (!CONVERSATION_ID.test(id)) {
    throw new Error(`Cannot name a ${platform} conversation: id "${id}" is malformed.`);
  }
  return `${platform}:${id}`;
}

export function parseChatThreadName(name: string): { platform: ChatPlatform; conversationId: string } | null {
  const match = THREAD_NAME.exec(name);
  if (!match) return null;
  return { platform: match[1] as ChatPlatform, conversationId: match[2]! };
}

export interface ChatTaskRequest {
  repoUrl: string;
  task: string;
}

/**
 * Split request text into repository and task. The repository is the first
 * GitHub URL in the text, else this conversation's entry in the repo map.
 * A missing half returns a usage message instead — no run is queued.
 */
export function parseChatTaskRequest(input: {
  text: string;
  conversationId: string;
  repoMap?: string;
  mapName: string;
  usage: string;
}): ChatTaskRequest | { error: string } {
  const inText = extractGitHubRepoUrl(input.text);
  const repoUrl = inText ?? parseChannelRepoMap(input.repoMap)[input.conversationId] ?? null;
  const task = (inText ? input.text.replace(inText, " ") : input.text).replace(/\s+/g, " ").trim();
  if (!repoUrl) {
    return {
      error: `No repository: include a https://github.com/owner/repo URL, or map this conversation in ${input.mapName}. ${input.usage}`,
    };
  }
  if (!task) {
    return { error: `Describe the task after the repository URL. ${input.usage}` };
  }
  return { repoUrl, task };
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

// Discord caps a message at 2000 chars; oversized tasks post as follow-up
// chunks in the same thread — the card can never hide approved text.
const CARD_TASK_LIMIT = 1500;

/** Plain-text card body: the exact frozen input the approver is deciding on. */
export function chatApprovalText(input: { repoUrl: string; task: string; approvalId: string; route?: string }): string {
  const task = input.task.length <= CARD_TASK_LIMIT
    ? input.task
    : `${input.task.slice(0, CARD_TASK_LIMIT)}… (${input.task.length - CARD_TASK_LIMIT} more chars — full task in this thread)`;
  const route = input.route ? `\nRoute: ${input.route}` : "";
  return `Approval requested\nRepo: ${input.repoUrl}\nTask: ${task}${route}\napproval ${input.approvalId}`;
}

/**
 * Task text split to fit a platform message cap, or [] when it fits in one.
 * Lanes post these as follow-ups next to the card so an approver can always
 * read the entire task before pressing Approve.
 */
export function chatTaskChunks(task: string, limit: number): string[] {
  if (task.length <= limit) return [];
  const chunks: string[] = [];
  for (let i = 0; i < task.length; i += limit) {
    chunks.push(task.slice(i, i + limit));
  }
  return chunks;
}

export function decisionLine(approved: boolean, who: string): string {
  return approved ? `Approved by ${who} — run starting.` : `Rejected by ${who} — no run started.`;
}

export interface OrchestratorStub {
  fetch: (request: Request) => Promise<Response>;
}

export type ResolveOrchestrator = (threadKey: string) => Promise<OrchestratorStub>;

function defaultResolver(env: Env): ResolveOrchestrator {
  return async (threadKey) => (await getAgentByName(env.CodingOrchestrator, threadKey)) as unknown as OrchestratorStub;
}

/** Queue a pending approval on the conversation's orchestrator. Never throws. */
export async function queueChatRun(
  env: Env,
  input: { platform: ChatPlatform; threadKey: string; repoUrl: string; task: string; userId: string; harness?: string },
  resolve: ResolveOrchestrator = defaultResolver(env),
): Promise<{ approvalId: string; route?: string } | { error: string }> {
  let response: Response;
  try {
    const stub = await resolve(input.threadKey);
    response = await stub.fetch(
      new Request("https://internal/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same defaults as the Slack lane: open a pull request, report back here.
        body: JSON.stringify({
          repoUrl: input.repoUrl,
          task: input.task,
          baseBranch: "main",
          publishPullRequest: true,
          threadKey: input.threadKey,
          source: input.platform,
          ...(input.harness ? { harness: input.harness } : {}),
          ...(input.userId ? { user_id: input.userId } : {}),
        }),
      }),
    );
  } catch {
    return { error: "The orchestrator is unreachable." };
  }
  const body = (await response.json().catch(() => ({}))) as { approvalId?: unknown; route?: unknown; error?: unknown };
  if (!response.ok || typeof body.approvalId !== "string") {
    // Surface the orchestrator's reason: a config error (e.g. no GITHUB_TOKEN) won't clear on retry.
    return { error: typeof body.error === "string" ? body.error : "Try again in a moment." };
  }
  return {
    approvalId: body.approvalId,
    // The frozen route is shown on the card so approvers see what will run.
    ...(typeof body.route === "string" ? { route: body.route } : {}),
  };
}

/**
 * Resolve a pending approval. The orchestrator re-checks the pointer, so a
 * stale or replayed button resolves nothing and is reported as such.
 */
export async function decideChatApproval(
  env: Env,
  input: { platform: ChatPlatform; threadKey: string; approvalId: string; approved: boolean; decidedBy: string },
  resolve: ResolveOrchestrator = defaultResolver(env),
): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response;
  try {
    const stub = await resolve(input.threadKey);
    response = await stub.fetch(
      new Request("https://internal/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadKey: input.threadKey,
          approvalId: input.approvalId,
          approved: input.approved,
          decidedBy: input.decidedBy,
          source: input.platform,
        }),
      }),
    );
  } catch {
    return { ok: false, error: "The orchestrator is unreachable — nothing was recorded." };
  }
  const body = (await response.json().catch(() => ({}))) as { result?: unknown; error?: unknown };
  if (!response.ok) {
    return {
      ok: false,
      error: typeof body.error === "string" ? body.error : `The decision could not be recorded (${response.status}).`,
    };
  }
  // Anything but a recorded decision is not a success — covers "unknown" today
  // and any future non-approved/rejected result string.
  if (body.result !== "approved" && body.result !== "rejected") {
    return { ok: false, error: "This approval is already resolved or expired — nothing to do." };
  }
  return { ok: true };
}

/** Bounded insertion-ordered set of delivery ids already acked. */
export function createSeenRing(max: number) {
  const seen = new Set<string>();
  return {
    has: (key: string) => seen.has(key),
    add(key: string) {
      seen.add(key);
      if (seen.size > max) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
    clear: () => seen.clear(),
  };
}

/** Outbound chat-API calls hang forever without a bound; 30s matches github-project.ts. */
const API_TIMEOUT_MS = 30_000;

/** Telegram Bot API call. The token rides the URL path, so errors never include the URL. */
export async function telegramApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`Telegram ${method} request failed.`);
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  // Telegram reports app-level failures as ok:false with a description.
  if (!response.ok || json.ok !== true) {
    const reason = typeof json.description === "string" ? json.description : "unparseable response";
    throw new Error(`Telegram ${method} failed (${response.status}): ${reason}`);
  }
  return json;
}

export interface DiscordRequestInit {
  method: string;
  body?: unknown;
  botToken?: string;
}

/** Discord REST call. Webhook paths embed the interaction token, so errors name only `label`. */
export async function discordApi(label: string, path: string, init: DiscordRequestInit): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${DISCORD_API}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        ...(init.botToken ? { Authorization: `Bot ${init.botToken}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`Discord ${label} request failed.`);
  }
  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { message?: unknown };
    const reason = typeof json.message === "string" ? json.message : "unparseable response";
    throw new Error(`Discord ${label} failed (${response.status}): ${reason}`);
  }
}

/**
 * Relay run progress into the chat a thread-keyed orchestrator came from.
 * Returns null when `threadName` is not a chat conversation or the lane has
 * no bot token, so the caller can fall through to its other post-backs.
 */
export function postToChatThread(env: Env, threadName: string, text: string): Promise<void> | null {
  const ids = parseChatThreadName(threadName);
  if (!ids) return null;
  if (ids.platform === "telegram") {
    const token = env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) return null;
    return telegramApi(token, "sendMessage", { chat_id: ids.conversationId, text: text.slice(0, 4000) }).then(() => undefined);
  }
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token) return null;
  return discordApi("post-back", `/channels/${ids.conversationId}/messages`, {
    method: "POST",
    botToken: token,
    body: { content: text.slice(0, 2000), allowed_mentions: NO_MENTIONS },
  });
}
