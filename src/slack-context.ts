/**
 * Slack context for T13: repo resolution, burst grouping, thread controls,
 * and bounded/redacted context gathering.
 *
 * Repo resolution never guesses: (1) a GitHub URL in the mention or thread,
 * (2) the SLACK_CHANNEL_REPOS channel->repo map, (3) otherwise ask — no run.
 */
import { boundTail, parseGitHubRepoUrl, redactSecrets } from "./security.js";

export interface SlackThreadMessage {
  user: string;
  text: string;
  /** Seconds since epoch (Slack `ts` as a number for testability). */
  ts: number;
}

export const DEFAULT_BURST_WINDOW_SECONDS = 10;
export const MIN_BURST_WINDOW_SECONDS = 1;
export const MAX_BURST_WINDOW_SECONDS = 300;
export const MAX_BURST_MESSAGES = 20;
export const MAX_BURST_BYTES = 100 * 1024;
export const MAX_CONTEXT_MESSAGES = 50;
export const MAX_CONTEXT_CHARS_PER_MESSAGE = 4000;

const GITHUB_URL_PATTERN = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\b/g;

/** Clamp the burst window to 1–300s; non-finite input falls back to 10s. */
export function clampBurstWindowSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_BURST_WINDOW_SECONDS;
  }
  if (value < MIN_BURST_WINDOW_SECONDS) {
    return MIN_BURST_WINDOW_SECONDS;
  }
  if (value > MAX_BURST_WINDOW_SECONDS) {
    return MAX_BURST_WINDOW_SECONDS;
  }
  return value;
}

/** First valid GitHub repo URL in `text`, or null. */
export function extractGitHubRepoUrl(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const matches = text.match(GITHUB_URL_PATTERN);
  if (!matches) {
    return null;
  }
  for (const raw of matches) {
    const candidate = raw.replace(/[.,;:!?)]+$/, "");
    try {
      parseGitHubRepoUrl(candidate);
      return candidate;
    } catch {
      // Not a valid repo URL — keep scanning.
    }
  }
  return null;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Parse the SLACK_CHANNEL_REPOS JSON map (`{channelId: repoUrl}`). Invalid input yields {}. */
export function parseChannelRepoMap(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface ResolveSlackRepoArgs {
  mentionText: string;
  threadTexts: string[];
  channelId: string;
  channelRepos: Record<string, string>;
}

export type SlackRepoResolution =
  | { kind: "repo"; repoUrl: string }
  | { kind: "ask"; message: string; startRun: false };

/**
 * Resolve the repo for a Slack mention. URL beats the channel default;
 * without either, ask which repo — the caller must start no run.
 */
export function resolveSlackRepo(args: ResolveSlackRepoArgs): SlackRepoResolution {
  const fromMention = extractGitHubRepoUrl(args.mentionText);
  if (fromMention) {
    return { kind: "repo", repoUrl: fromMention };
  }
  for (const text of args.threadTexts) {
    const fromThread = extractGitHubRepoUrl(text);
    if (fromThread) {
      return { kind: "repo", repoUrl: fromThread };
    }
  }
  const mapped = args.channelRepos[args.channelId];
  if (typeof mapped === "string" && mapped.length > 0) {
    try {
      parseGitHubRepoUrl(mapped);
      return { kind: "repo", repoUrl: mapped };
    } catch {
      // Invalid mapped value falls through to ask.
    }
  }
  return {
    kind: "ask",
    message: "Which repo should I use? Reply with a https://github.com/owner/repo URL.",
    startRun: false,
  };
}

export interface BurstGroupOptions {
  windowSeconds?: number;
  maxMessages?: number;
  maxBytes?: number;
}

/**
 * Group messages into bursts: one run per burst, not per message. A new
 * burst starts when the sliding window elapses since the previous message,
 * a different author posts, or the 20-message / 100KB bounds are hit.
 */
export function groupMessageBursts(
  messages: SlackThreadMessage[],
  options: BurstGroupOptions = {},
): SlackThreadMessage[][] {
  const windowSeconds = clampBurstWindowSeconds(
    options.windowSeconds ?? DEFAULT_BURST_WINDOW_SECONDS,
  );
  const maxMessages = options.maxMessages ?? MAX_BURST_MESSAGES;
  const maxBytes = options.maxBytes ?? MAX_BURST_BYTES;
  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  const groups: SlackThreadMessage[][] = [];
  let current: SlackThreadMessage[] = [];
  let currentBytes = 0;
  let lastTs = 0;
  let lastAuthor = "";
  for (const message of sorted) {
    const size = byteLength(message.text);
    const windowElapsed = current.length > 0 && message.ts - lastTs > windowSeconds;
    const authorChanged = current.length > 0 && message.user !== lastAuthor;
    const countBound = current.length >= maxMessages;
    const bytesBound = current.length > 0 && currentBytes + size > maxBytes;
    if (windowElapsed || authorChanged || countBound || bytesBound) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    // A single oversized message still forms its own burst.
    if (current.length === 0 && size > maxBytes) {
      groups.push([message]);
      lastTs = message.ts;
      lastAuthor = message.user;
      continue;
    }
    current.push(message);
    currentBytes += size;
    lastTs = message.ts;
    lastAuthor = message.user;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

const ASIDE_PATTERN = /^\s*aside\b/i;
const MUTE_PATTERN = /^\s*mute\b/i;
const UNMUTE_PATTERN = /^\s*unmute\b/i;

/**
 * Apply Capy-style thread controls: `aside …` messages are excluded from
 * processing entirely; `mute` stops replies to non-mention messages until
 * `unmute`. Command messages themselves are kept so the transcript reads.
 */
export function applyThreadControls(
  messages: SlackThreadMessage[],
  botId = "",
): SlackThreadMessage[] {
  const out: SlackThreadMessage[] = [];
  let muted = false;
  for (const message of messages) {
    const text = message.text ?? "";
    if (ASIDE_PATTERN.test(text)) {
      continue;
    }
    if (MUTE_PATTERN.test(text) && !UNMUTE_PATTERN.test(text)) {
      muted = true;
      out.push(message);
      continue;
    }
    if (UNMUTE_PATTERN.test(text)) {
      muted = false;
      out.push(message);
      continue;
    }
    if (muted) {
      if (botId.length > 0 && text.includes(botId)) {
        out.push(message);
      }
      continue;
    }
    out.push(message);
  }
  return out;
}

export interface GatherSlackContextArgs {
  threadMessages: SlackThreadMessage[];
  linkedTexts?: string[];
  maxMessages?: number;
  maxCharsPerMessage?: number;
  burstWindowSeconds?: number;
}

/**
 * Assemble bounded, redacted context: `aside` messages excluded, thread
 * capped at ~50 messages (most recent win), same-author rapid-fire
 * messages collapsed into one burst line (`⋮` separator, `+N` marker),
 * each body tail-bounded, linked issue/PR text appended, secrets redacted
 * over the whole assembly.
 */
export function gatherSlackContext(args: GatherSlackContextArgs): string {
  const maxMessages = args.maxMessages ?? MAX_CONTEXT_MESSAGES;
  const maxChars = args.maxCharsPerMessage ?? MAX_CONTEXT_CHARS_PER_MESSAGE;
  const visible = applyThreadControls(args.threadMessages);
  const tail = visible.slice(-Math.max(maxMessages, 0));
  const lines = groupMessageBursts(tail, { windowSeconds: args.burstWindowSeconds }).map(
    (burst) => {
      const first = burst[0]!;
      const texts = burst.map((message) => boundTail(message.text, maxChars)).join(" ⋮ ");
      const extra = burst.length > 1 ? ` +${burst.length - 1}` : "";
      return `[${first.user} ${first.ts}${extra}] ${texts}`;
    },
  );
  for (const linked of args.linkedTexts ?? []) {
    lines.push(`[linked] ${boundTail(linked, maxChars)}`);
  }
  return redactSecrets(lines.join("\n"));
}
