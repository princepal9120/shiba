/**
 * Explicit structured envelope for parent to child agent-tool input.
 * The parent formats with formatAgentToolInput; the child parses with
 * parseAgentToolInput. The child never scrapes arbitrary prose.
 */
import { z } from "zod";
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
  harness: z.enum(["opencode", "claude-code", "codex", "devin"]).optional(),
});

export type CodingTaskInput = z.infer<typeof codingTaskInputSchema>;

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
});

export type CodingTaskResult = z.infer<typeof codingTaskResultSchema>;

export function formatAgentToolInput(input: CodingTaskInput): string {
  const parsed = codingTaskInputSchema.parse(input);
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
      const parsed = codingTaskInputSchema.safeParse(candidate);
      if (parsed.success) {
        parseGitHubRepoUrl(parsed.data.repoUrl);
        return parsed.data;
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
