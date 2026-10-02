/**
 * Explicit structured envelope for parent to child agent-tool input.
 * The parent formats with formatAgentToolInput; the child parses with
 * parseAgentToolInput. The child never scrapes arbitrary prose.
 */
import { z } from "zod";
import { RUN_SIGNAL_KINDS, runtimeSelectionSchema } from "@shiba/shared";
import { isApprovedRoute, type ApprovedRoute } from "./model-connections.js";
import { parseGitHubRepoUrl } from "./security.js";

export const TOOL_INPUT_MARKER = "SHIBA_AI_COWORKER_CODING_TASK_JSON";
export const RESULT_MARKER = "SHIBA_AI_COWORKER_CODING_RESULT_JSON";

const codingTaskInputSchema = z.object({
  repoUrl: z.string().min(1),
  task: z.string().min(1),
  baseBranch: z.string().min(1),
  publishPullRequest: z.boolean(),
  sandboxId: z.string().min(1),
  codingModel: z.string().min(1),
  /** Which coding agent runs the task. Validated at approval time, never in the container. */
  harness: z.enum(["opencode", "claude-code", "claude-subscription", "codex", "codex-subscription", "devin", "grok", "antigravity-subscription", "cursor-subscription", "devin-subscription"]).optional(),
  /**
   * T48: which subscription account a subscription-authed harness runs
   * under — maps to `CLAUDE_SUBSCRIPTION_TOKEN` (default) or
   * `CLAUDE_SUBSCRIPTION_TOKEN_<ACCOUNT>` Worker secrets. Frozen by the
   * approval hash like every other input field; never the credential.
   */
  authAccount: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
  /**
   * The frozen, approval-gated route (connection/model/harness ids only —
   * spec MODEL-CONNECTIONS-ARCHITECTURE.md §4). Validated with
   * {@link isApprovedRoute} after parsing; absent on pre-route envelopes.
   */
  route: z.unknown().optional(),
  /**
   * Slack thread to post progress into while the run executes. Set only for
   * Slack-originated runs; the child posts throttled coworker-voice updates
   * with the bot token — channel/ts are routing data, not credentials.
   */
  slackThread: z
    .object({
      channelId: z.string().min(1),
      threadTs: z.string().min(1),
    })
    .optional(),
  /**
   * T45: the project's test command as argv (e.g. ["pnpm","test"]). Runs
   * inside the sandbox through the scoped executor — it must match the
   * harness's declared execAllowlist, and verify fails the run when it is
   * refused or exits nonzero.
   */
  testCommand: z.array(z.string().min(1)).max(8).optional(),
  /**
   * T51: the approved runtime. `"local"` runs on the operator's machine
   * via the dispatch mailbox — admissible only from a dashboard intake
   * under SHIBA_LOCAL_RUNTIME=1; every chat surface refuses it at intake.
   */
  runtime: runtimeSelectionSchema.optional(),
});

const codingTaskInputWithRouteSchema = codingTaskInputSchema.superRefine((input, ctx) => {
  if (input.route !== undefined && !isApprovedRoute(input.route)) {
    ctx.addIssue({ code: "custom", message: "route must be an ApprovedRoute (connection/model/harness ids only)." });
  }
});

export type CodingTaskInput = Omit<z.infer<typeof codingTaskInputSchema>, "route"> & {
  route?: ApprovedRoute;
};

const changedFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().nullable(),
  encoding: z.enum(["utf8", "base64"]),
});

const codingTaskResultSchema = z.object({
  status: z.enum(["completed", "error"]),
  exitCode: z.number(),
  stderrTail: z.string(),
  changedFiles: z.array(z.string()),
  diff: z.string(),
  files: z.array(changedFileSchema),
  summary: z.string(),
  /**
   * The PR the child published, when it did. Carried on the envelope so the
   * parent reads it from structured output — never scraped out of rendered
   * text, where agent stdout could plant a fake `Pull request:` line.
   */
  pullUrl: z.string().optional(),
  /**
   * Stored screenshot link captured at run end (T33), carried on the
   * envelope like pullUrl so the parent records it from structured output.
   * The sandbox preview URL itself is ephemeral and never leaves the worker.
   */
  screenshotUrl: z.string().optional(),
  /**
   * T46: evidence that a declared testCommand actually ran — command (shell-
   * joined form), exit code, and a bounded output tail. Rides the envelope so
   * the PR body quotes the real verification output instead of a summary.
   */
  testEvidence: z
    .object({
      command: z.string(),
      exitCode: z.number(),
      outputTail: z.string(),
    })
    .optional(),
  /**
   * T42 typed run signals, in emission order. The orchestrator persists
   * them on the run row so a waiter reads the milestone it needs instead
   * of ordering by convention. Partial on a failed run.
   */
  signals: z
    .array(
      z.object({
        kind: z.enum(RUN_SIGNAL_KINDS),
        at: z.number(),
        detail: z.string().optional(),
      }),
    )
    .optional(),
});

export type CodingTaskResult = z.infer<typeof codingTaskResultSchema>;

export function formatAgentToolInput(input: CodingTaskInput): string {
  const parsed = codingTaskInputWithRouteSchema.parse(input);
  // Validate the repo URL eagerly so a bad URL fails before approval.
  parseGitHubRepoUrl(parsed.repoUrl);
  return `${TOOL_INPUT_MARKER}\n${JSON.stringify(parsed)}`;
}

export interface ChatTextMessage {
  role: string;
  text: string;
}

/**
 * Parse the most recent user message carrying the envelope. Accepts the
 * marker-prefixed JSON string, a JSON-encoded wrapping of that string, or
 * the raw input object. Throws when nothing structured is found. The
 * payload is always validated with zod; free prose is never interpreted.
 */
export function parseAgentToolInput(messages: ChatTextMessage[]): CodingTaskInput {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ChatTextMessage;
    if (message.role !== "user") continue;
    for (const candidate of candidatePayloads(message.text)) {
      const parsed = codingTaskInputWithRouteSchema.safeParse(candidate);
      if (parsed.success) {
        parseGitHubRepoUrl(parsed.data.repoUrl);
        return parsed.data as CodingTaskInput;
      }
    }
  }
  throw new Error("No structured coding task envelope found in chat history.");
}

function* candidatePayloads(text: string): Generator<unknown> {
  const marker = `${TOOL_INPUT_MARKER}\n`;
  if (text.startsWith(marker)) {
    yield safeJson(text.slice(marker.length));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof parsed === "string") {
    if (parsed.startsWith(marker)) {
      yield safeJson(parsed.slice(marker.length));
    }
    return;
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    yield parsed;
    for (const value of Object.values(parsed)) {
      if (typeof value === "string" && value.startsWith(marker)) {
        yield safeJson(value.slice(marker.length));
      }
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function formatAgentResult(result: CodingTaskResult): string {
  const parsed = codingTaskResultSchema.parse(result);
  return `${RESULT_MARKER}\n${JSON.stringify(parsed)}`;
}

export function parseAgentResultText(text: string): CodingTaskResult {
  const marker = `${RESULT_MARKER}\n`;
  const index = text.lastIndexOf(marker);
  if (index < 0) {
    throw new Error("No structured coding result envelope found.");
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(index + marker.length));
  } catch {
    throw new Error("Coding result envelope is not valid JSON.");
  }
  return codingTaskResultSchema.parse(json);
}

/**
 * Non-throwing result parser for the orchestrator. Returns the validated
 * envelope or null when absent/malformed so callers never mark a failed
 * or garbled run as silently successful.
 */
export function parseAgentResult(text: string): CodingTaskResult | null {
  try {
    return parseAgentResultText(text);
  } catch {
    return null;
  }
}
