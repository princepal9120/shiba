/**
 * The intern's Slack voice — a coworker, not a task machine.
 *
 * One place owns how the intern talks in Slack: the voice spec below is
 * the contract, and every message the worker posts in a channel, thread,
 * or DM goes through the formatting helpers here so it reads like the
 * same teammate wrote it. Keep the register: plain, warm, concise,
 * first-person — a colleague checking in ("on it", "found the issue,
 * fixing", "done, here's the diff"), never corporate bot boilerplate
 * ("Request received", "Your task is being processed", "as an AI").
 */
import { boundTail } from "./security.js";

/**
 * The voice spec, kept as data so docs and tests can pin it. The helpers
 * in this file are the live implementation — new Slack-facing text goes
 * through them, not inline strings.
 */
export const SLACK_COWORKER_VOICE = [
  "You are AI Intern, a coworker who lives in Slack.",
  "Write like a teammate: plain, warm, concise, first-person, short sentences.",
  "Say what you are doing and what happened — 'on it', 'found it, fixing', 'done, here's the diff'.",
  "Never corporate bot boilerplate, never 'as an AI', never 'Request received'.",
  "Be honest about failure: say what broke and what you tried.",
].join(" ");

/** Slack hard-truncates long messages; stay well under that. */
export const SLACK_MAX_MESSAGE_CHARS = 3000;

/** `owner/repo` short form for chat; falls back to the raw string. */
export function shortRepoName(repoUrl: string): string {
  const match = /github\.com\/([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  return match?.[1] ?? repoUrl;
}

/** Human name for a coding harness id. */
export function describeHarness(harness: string | undefined): string {
  switch (harness) {
    case "claude-code":
      return "claude code";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    case "devin":
      return "devin";
    default:
      return "the coding agent";
  }
}

/** "a claude code" / "an opencode" — the agent phrase for prose. */
export function agentPhrase(harness: string | undefined): string {
  const name = describeHarness(harness);
  if (name.startsWith("the ")) return name;
  return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
}

/** No repo resolved: ask in-thread, start nothing. */
export function slackAskForRepo(): string {
  return "which repo should i work in? drop the github link and i'll take it from there.";
}

/** Repo resolved but nothing to do: ask what the task is. */
export function slackAskForTask(): string {
  return "got the repo — what do you need done? a line or two is plenty.";
}

/**
 * Ack a queued task. The approval card below it carries the exact input;
 * this line is just the coworker "on it".
 */
export function slackAck(input: { repoUrl: string; harness?: string }): string {
  return `on it — queued ${agentPhrase(input.harness)} run for ${shortRepoName(input.repoUrl)}. tap approve and i'll start.`;
}

/** Queueing itself failed before any run existed. */
export function slackQueueFailed(): string {
  return "couldn't queue that one — try again in a sec, or hit me with /shiba-ai-coworker.";
}

/** Run admitted and the container is starting. */
export function slackRunStarted(input: { repoUrl: string; baseBranch?: string; harness?: string }): string {
  const branch = input.baseBranch ?? "main";
  return `on it — ${describeHarness(input.harness)} is starting on ${shortRepoName(input.repoUrl)} (${branch}). i'll post updates here.`;
}

export interface SlackRunDone {
  repoUrl: string;
  /** The coding agent's own summary, already secret-redacted. */
  summary: string;
  changedFiles?: number;
  pullUrl?: string | null;
}

/** Terminal success post: what changed and where to look. */
export function slackRunCompleted(input: SlackRunDone): string {
  const lines = [`done — here's what changed in ${shortRepoName(input.repoUrl)}:`];
  const summary = input.summary.trim();
  if (summary) {
    lines.push(boundTail(summary, 1500));
  }
  if (typeof input.changedFiles === "number") {
    lines.push(`${input.changedFiles} file${input.changedFiles === 1 ? "" : "s"} changed.`);
  }
  if (input.pullUrl) {
    lines.push(`PR: ${input.pullUrl}`);
  }
  return boundTail(lines.join("\n"), SLACK_MAX_MESSAGE_CHARS);
}

/** Terminal failure post: plain what-broke plus what it tried. */
export function slackRunFailed(input: {
  repoUrl: string;
  /** Classified user-facing explanation (run-errors wire). */
  userMessage: string;
  /** Raw error detail, truncated for the thread. */
  detail?: string;
  /** Outcome indeterminate — side effects unverified. */
  unknown?: boolean;
}): string {
  const opener = input.unknown
    ? `not sure how the ${shortRepoName(input.repoUrl)} run ended`
    : `that run didn't land on ${shortRepoName(input.repoUrl)}`;
  const lines = [`${opener} — ${input.userMessage}`];
  const detail = input.detail?.trim() ?? "";
  if (detail) {
    lines.push(`what i saw: ${boundTail(detail, 800)}`);
  }
  return boundTail(lines.join("\n"), SLACK_MAX_MESSAGE_CHARS);
}

/** Human-cancelled run. */
export function slackRunCancelled(input: { repoUrl: string }): string {
  return `cancelled the ${shortRepoName(input.repoUrl)} run. if a PR was mid-publish it may still land — check the repo before re-running.`;
}

export interface SlackProgressEventLike {
  phase: string;
  message: string;
}

/** One progress line in the coworker voice. */
export function slackProgressText(event: SlackProgressEventLike): string {
  const detail = boundTail(event.message.trim(), 120);
  switch (event.phase) {
    case "clone":
      return "cloning the repo";
    case "configure":
      return "setting up the workspace";
    case "collect":
      return detail ? `wrapping up — ${detail}` : "wrapping up — collecting the diff";
    default:
      return detail ? `still on it — ${detail}` : "still on it";
  }
}

/** Slack progress posts: phase beats plus a heartbeat, never a log stream. */
export const SLACK_PROGRESS_MAX_POSTS = 8;
export const SLACK_PROGRESS_HEARTBEAT_EVERY = 10;

/**
 * Throttles run progress into a Slack thread: the first event, every phase
 * transition, and every Nth "code" heartbeat — a coworker's "still on it"
 * cadence. A Slack post failure must never fail the run, so post errors
 * are swallowed here; the run transcript carries the same progress.
 */
export class SlackProgressReporter {
  private posts = 0;
  private lastPhase: string | null = null;
  private codeBeats = 0;

  constructor(
    private readonly post: (text: string) => Promise<void>,
    private readonly maxPosts: number = SLACK_PROGRESS_MAX_POSTS,
  ) {}

  async onEvent(event: SlackProgressEventLike): Promise<void> {
    if (this.posts >= this.maxPosts) {
      return;
    }
    const first = this.lastPhase === null;
    const phaseChanged = !first && event.phase !== this.lastPhase;
    const heartbeat = event.phase === "code" && ++this.codeBeats % SLACK_PROGRESS_HEARTBEAT_EVERY === 0;
    this.lastPhase = event.phase;
    if (!(first || phaseChanged || heartbeat)) {
      return;
    }
    try {
      await this.post(slackProgressText(event));
      this.posts += 1;
    } catch {
      // Best-effort — the child transcript already carries the same lines.
    }
  }
}
