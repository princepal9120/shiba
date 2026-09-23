/**
 * Mention dispatch (PLAN T13/T14/T16). Events already acked; this runs in waitUntil.
 * No bot token → no in-thread card and no run. No repo → ask, no run.
 */
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { postSystemOne, readChoiceAnswer, type TypeSafeFetch } from "./typesafe.js";
import { buildApprovalBlocks } from "./slack-approval.js";
import {
  gatherSlackContext,
  parseChannelRepoMap,
  resolveSlackRepo,
  type SlackThreadMessage,
} from "./slack-context.js";
import type { SlackEventCallbackBody } from "./slack-events.js";
import {
  buildSlackRunPayload,
  buildSlackThreadName,
  getSlackThreadStub,
  resolveThreadTs,
} from "./slack-thread.js";

const SLACK_POST_MESSAGE = "https://slack.com/api/chat.postMessage";
const SLACK_REPLIES = "https://slack.com/api/conversations.replies";

export interface SlackMentionQueueResult {
  approvalId: string;
}

export interface SlackMentionDeps {
  queueRun?: (input: {
    threadKey: string;
    repoUrl: string;
    task: string;
    channelId: string;
    userId: string;
  }) => Promise<SlackMentionQueueResult>;
  postMessage?: (input: {
    channel: string;
    threadTs: string;
    text: string;
    blocks?: unknown[];
  }) => Promise<void>;
  fetchThread?: (channel: string, threadTs: string) => Promise<SlackThreadMessage[]>;
  /** Injected in tests to mock the TypeSafe API call for intent classification. */
  typeSafeFetch?: MentionFetchImpl;
}

interface AppMentionEvent {
  type: "app_mention";
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
}

function asAppMention(event: unknown): AppMentionEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const candidate = event as { type?: unknown };
  if (candidate.type !== "app_mention") return null;
  return event as AppMentionEvent;
}

function stripMentionMarkers(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, " ").replace(/\s+/g, " ").trim();
}

function requireSlackOk(response: Response, json: Record<string, unknown>): void {
  // Slack answers HTTP 200 with {ok:false, error} — check both.
  if (!response.ok || json.ok !== true) {
    throw new Error(typeof json.error === "string" ? json.error : `Slack API ${response.status}`);
  }
}

async function slackApi(
  token: string,
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  requireSlackOk(response, json);
  return json;
}

// conversations.replies is a GET method — query params, not a JSON body.
async function slackApiGet(
  token: string,
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params);
  const response = await fetch(`${url}?${query.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  requireSlackOk(response, json);
  return json;
}

async function defaultPostMessage(
  token: string,
  input: { channel: string; threadTs: string; text: string; blocks?: unknown[] },
): Promise<void> {
  await slackApi(token, SLACK_POST_MESSAGE, {
    channel: input.channel,
    thread_ts: input.threadTs,
    text: input.text,
    ...(input.blocks ? { blocks: input.blocks } : {}),
  });
}

async function defaultFetchThread(token: string, channel: string, threadTs: string): Promise<SlackThreadMessage[]> {
  const json = await slackApiGet(token, SLACK_REPLIES, { channel, ts: threadTs, limit: "50" });
  const messages = Array.isArray(json.messages) ? json.messages : [];
  const out: SlackThreadMessage[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as { user?: unknown; text?: unknown; ts?: unknown };
    if (typeof msg.text !== "string" || typeof msg.ts !== "string") continue;
    const ts = Number(msg.ts);
    if (!Number.isFinite(ts)) continue;
    out.push({
      user: typeof msg.user === "string" ? msg.user : "unknown",
      text: msg.text,
      ts,
    });
  }
  return out;
}


export const SLACK_INTENT_TYPES = ["fix", "implement", "explain", "other"] as const;
export type SlackMentionIntent = (typeof SLACK_INTENT_TYPES)[number];

/** Pluggable fetch for tests. */
export type MentionFetchImpl = TypeSafeFetch;

export interface SlackMentionIntentResult {
  intent: SlackMentionIntent;
  /** Probability [0, 1] that the chosen intent is correct. */
  probability: number;
}

/**
 * Use TypeSafe Choice to classify what a Slack mention is asking for.
 * Returns null when apiKey is absent, or on HTTP/parse failure — callers
 * treat null as no classification and proceed unchanged.
 *
 * The result sharpens the orchestrator system prompt; it does not gate the
 * run. The approval card remains the human checkpoint regardless of intent.
 */
export async function classifySlackMentionIntent(
  apiKey: string,
  mentionText: string,
  threadSummary: string,
  fetchImpl: MentionFetchImpl = fetch,
): Promise<SlackMentionIntentResult | null> {
  if (!apiKey.trim() || !mentionText.trim()) return null;
  const answers = await postSystemOne(
    apiKey,
    { mention: mentionText, thread: threadSummary },
    {
      intent: {
        type: "choice",
        instructions: "What is the user primarily asking the coding agent to do?",
        criteria: {
          fix: "Fix a bug, error, test failure, or broken behaviour",
          implement: "Add a new feature, function, endpoint, or capability",
          explain: "Explain, summarise, or document existing code or behaviour",
          other: "Anything else: refactor, chore, question, or unclear",
        },
      },
    },
    fetchImpl,
  );
  if (answers === null) return null;
  const parsed = readChoiceAnswer(answers, "intent");
  if (!parsed) return null;
  const intent = SLACK_INTENT_TYPES.includes(parsed.choice as SlackMentionIntent)
    ? (parsed.choice as SlackMentionIntent)
    : "other";
  return { intent, probability: parsed.probability };
}

/**
 * Build a sharpened system-prompt hint from a TypeSafe intent classification.
 * Returns an empty string when classification is absent so callers can append
 * it without a branch.
 */
export function intentHint(classification: SlackMentionIntentResult | null): string {
  if (!classification) return "";
  const labels: Record<SlackMentionIntent, string> = {
    fix: "The user wants you to fix a bug or broken behaviour.",
    implement: "The user wants you to implement a new feature or capability.",
    explain: "The user wants an explanation or documentation update.",
    other: "",
  };
  return labels[classification.intent] ?? "";
}


export async function handleSlackEvent(
  body: SlackEventCallbackBody,
  env: Env,
  deps: SlackMentionDeps = {},
): Promise<void> {
  const event = asAppMention(body.event);
  if (!event) return;

  const token = env.SLACK_BOT_TOKEN?.trim() ?? "";
  const teamId = typeof body.team_id === "string" ? body.team_id : "";
  const channelId = event.channel?.trim() ?? "";
  const userId = event.user?.trim() ?? "";
  const mentionText = event.text ?? "";
  const threadTs = resolveThreadTs({ thread_ts: event.thread_ts, ts: event.ts });
  if (!channelId || !threadTs) return;

  const postMessage =
    deps.postMessage ??
    (token ? (input: Parameters<NonNullable<SlackMentionDeps["postMessage"]>>[0]) => defaultPostMessage(token, input) : undefined);
  // No bot token: cannot ask or post a card, so start no run.
  if (!postMessage) return;

  let threadMessages: SlackThreadMessage[] = [{
    user: userId || "unknown",
    text: mentionText,
    ts: Number(threadTs),
  }];
  const fetchThread = deps.fetchThread ?? (token ? (ch: string, ts: string) => defaultFetchThread(token, ch, ts) : undefined);
  if (fetchThread) {
    try {
      const fetched = await fetchThread(channelId, threadTs);
      if (fetched.length > 0) threadMessages = fetched;
    } catch (error) {
      console.error("Slack thread fetch failed", redactSecrets(String(error)));
    }
  }

  const resolution = resolveSlackRepo({
    mentionText,
    threadTexts: threadMessages.map((m) => m.text),
    channelId,
    channelRepos: parseChannelRepoMap(env.SLACK_CHANNEL_REPOS),
  });
  if (resolution.kind === "ask") {
    await postMessage({ channel: channelId, threadTs, text: resolution.message });
    return;
  }

  const task = gatherSlackContext({ threadMessages }) || stripMentionMarkers(mentionText);
  if (!task) {
    await postMessage({
      channel: channelId,
      threadTs,
      text: "What should I do in that repo? Reply with a short task.",
    });
    return;
  }

  // TypeSafe Choice: classify intent to sharpen the orchestrator system prompt.
  // Fail-open — null means no classification, no change to the run path.
  const intentApiKey = env.TYPESAFE_API_KEY?.trim() ?? "";
  const intentClassification = intentApiKey
    ? await classifySlackMentionIntent(
        intentApiKey,
        stripMentionMarkers(mentionText),
        task,
        deps.typeSafeFetch,
      ).catch(() => null)
    : null;
  const hint = intentHint(intentClassification);

  const threadKey = buildSlackThreadName(teamId, channelId, threadTs);
  // The hint becomes part of the task the run executes — the card renders
  // taskWithHint verbatim so the human approves exactly what will run.
  const taskWithHint = hint ? `${hint}
${task}` : task;

  const payload = buildSlackRunPayload({
    repoUrl: resolution.repoUrl,
    task: taskWithHint,
    channelId,
    userId,
  });
  const queueRun =
    deps.queueRun ??
    (async (input) => {
      const stub = await getSlackThreadStub<{ fetch: (request: Request) => Promise<Response> }>(env, {
        teamId,
        channelId,
        threadTs,
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

  try {
    const { approvalId } = await queueRun({
      threadKey,
      repoUrl: resolution.repoUrl,
      task: taskWithHint,
      channelId,
      userId,
    });
    await postMessage({
      channel: channelId,
      threadTs,
      text: `Task queued for ${resolution.repoUrl}`,
      blocks: buildApprovalBlocks({
        threadKey,
        approvalId,
        repoUrl: resolution.repoUrl,
        task: taskWithHint,
      }),
    });
  } catch (error) {
    console.error("Slack mention dispatch failed", redactSecrets(String(error)));
    await postMessage({
      channel: channelId,
      threadTs,
      text: "Could not queue that task. Try again or use `/shiba-ai-coworker`.",
    });
  }
}
