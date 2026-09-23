/**
 * One Slack thread is one orchestrator conversation.
 *
 * Naming the CodingOrchestrator DO after the thread (`slack:{team}:{channel}:{thread_ts}`)
 * gives each thread its own history, approval state, and run registry for free.
 * Approval gating, run registry, concurrency limits, and cancellation all work
 * unchanged — orchestrator.ts was written against a name, not "default".
 *
 * PROSE BOUNDARY (spec/GOAL.md: "do not scrape arbitrary prose"): that rule
 * governs the CHILD boundary (parseAgentToolInput), which stays untouched.
 * Human thread prose flows into the orchestrator LLM, which emits a structured
 * delegate_coding_task call — prose never crosses into the child. Do NOT add a
 * repo-URL regex here "to skip a model call"; that is exactly what the spec
 * forbids.
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";

/** The Slack path opens a pull request by default. */
export const SLACK_DEFAULT_PUBLISH_PR = true;

/** Slack message timestamps look like "1758217392.000100". */
const SLACK_TS_PATTERN = /^\d+\.\d+$/;

export interface SlackThreadIds {
  teamId: string;
  channelId: string;
  threadTs: string;
}

function requireId(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Cannot name a Slack thread conversation: ${label} is missing.`);
  }
  return trimmed;
}

/**
 * Build the CodingOrchestrator DO name for a Slack thread:
 * `slack:{teamId}:{channelId}:{threadTs}`.
 */
export function buildSlackThreadName(teamId: string, channelId: string, threadTs: string): string {
  const team = requireId("team_id", teamId);
  const channel = requireId("channel_id", channelId);
  const thread = requireId("thread_ts", threadTs);
  if (!SLACK_TS_PATTERN.test(thread)) {
    throw new Error(`Cannot name a Slack thread conversation: thread_ts "${thread}" is malformed.`);
  }
  return `slack:${team}:${channel}:${thread}`;
}

/**
 * Resolve the conversation timestamp for an incoming Slack event. A mention
 * already inside a thread carries `thread_ts`; a top-level mention starts a
 * new thread at its own `ts`. Returns null when neither is present.
 */
export function resolveThreadTs(event: { thread_ts?: string; ts?: string }): string | null {
  const candidate = event.thread_ts ?? event.ts ?? null;
  if (!candidate || !SLACK_TS_PATTERN.test(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Inverse of buildSlackThreadName — lets the orchestrator recover the Slack
 * channel/thread for result post-back without storing duplicate fields.
 */
export function parseSlackThreadName(name: string): SlackThreadIds | null {
  const match = /^slack:([^:]+):([^:]+):(\d+\.\d+)$/.exec(name);
  const [, teamId, channelId, threadTs] = match ?? [];
  if (!teamId || !channelId || !threadTs) return null;
  return { teamId, channelId, threadTs };
}

export interface SlackRunPayload {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  source: "slack";
  channel_id?: string;
  user_id?: string;
}

/**
 * Build the orchestrator run payload for the Slack path. PRs are requested by
 * default — the Slack surface reports back with a PR link in-thread.
 */
export function buildSlackRunPayload(input: {
  repoUrl: string;
  task: string;
  baseBranch?: string;
  channelId?: string;
  userId?: string;
}): SlackRunPayload {
  return {
    repoUrl: input.repoUrl,
    task: input.task,
    baseBranch: input.baseBranch ?? "main",
    publishPullRequest: SLACK_DEFAULT_PUBLISH_PR,
    source: "slack",
    ...(input.channelId ? { channel_id: input.channelId } : {}),
    ...(input.userId ? { user_id: input.userId } : {}),
  };
}

/**
 * Warn up front when the approval card would lead to a failure: orchestrator.ts
 * throws when publishPullRequest is set without GITHUB_TOKEN, which on this
 * path lands AFTER someone clicked Approve. Render the result on the card.
 * Returns null when a token is configured.
 */
export function missingGithubTokenWarning(env: { GITHUB_TOKEN?: string }): string | null {
  if (env.GITHUB_TOKEN) {
    return null;
  }
  return (
    "GITHUB_TOKEN is not configured: approving this run will fail when it " +
    "requests a pull request. Set the GITHUB_TOKEN secret or run without a PR."
  );
}

type ByName = (
  namespace: Env["CodingOrchestrator"],
  name: string,
) => Promise<unknown>;

/**
 * Resolve the CodingOrchestrator stub for a Slack thread. `byName` is
 * injectable so tests can pass a fake; production passes nothing and uses
 * the Agents SDK router.
 */
export async function getSlackThreadStub<Stub>(
  env: Env,
  ids: SlackThreadIds,
  byName: ByName = getAgentByName as unknown as ByName,
): Promise<Stub> {
  const name = buildSlackThreadName(ids.teamId, ids.channelId, ids.threadTs);
  return (await byName(env.CodingOrchestrator, name)) as Stub;
}
