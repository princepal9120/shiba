/**
 * Claude Code harness (PLAN.md T22).
 *
 * API-key only. Subscription credentials are deliberately not supported:
 * Anthropic's terms forbid third parties routing requests through Free/Pro/
 * Max plan credentials on behalf of users (PLAN.md §3). The container gets
 * the dummy key; the real one is injected at the egress boundary.
 */
import type { CodingTaskInput } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import { boundTail } from "../security.js";
import {
  assertSupportedModel,
  PROVIDER_HOSTS,
  PROVIDER_KEY_ENV,
  type AgentHarness,
} from "./types.js";

export const CLAUDE_CODE_PROVIDERS = ["anthropic"] as const;

/** Thrown when Claude Code reports an error in its stream-json output. */
export class ClaudeCodeErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "ClaudeCodeErrorEvent";
    this.detail = detail;
  }
}

export class ClaudeCodeEventError extends Error {}

/**
 * Parse one `--output-format stream-json` line. Claude Code emits
 * newline-delimited JSON envelopes; `is_error` marks a failed result, which
 * throws so the run fails honestly rather than reporting success.
 */
export function parseClaudeCodeEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    throw new ClaudeCodeEventError(`Unparseable Claude Code event: ${boundTail(trimmed, 200)}`);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new ClaudeCodeEventError("Claude Code event is not an object.");
  }
  const record = event as Record<string, unknown>;
  if (record.is_error === true || record.subtype === "error") {
    const detail = typeof record.result === "string"
      ? record.result
      : typeof record.error === "string"
        ? record.error
        : JSON.stringify(record);
    throw new ClaudeCodeErrorEvent(boundTail(detail, 500));
  }
  const text = claudeCodeText(record);
  return boundTail(text, 500);
}

function claudeCodeText(record: Record<string, unknown>): string {
  const message = record.message;
  if (typeof message === "object" && message !== null) {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts = content
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) return null;
          const block = entry as Record<string, unknown>;
          if (typeof block.text === "string") return block.text;
          if (typeof block.name === "string") return `tool: ${block.name}`;
          return null;
        })
        .filter((value): value is string => value !== null);
      if (parts.length > 0) return parts.join(" ").trim();
    }
  }
  if (typeof record.result === "string" && record.result.trim()) return record.result.trim();
  const type = typeof record.type === "string" ? record.type : "event";
  const keys = Object.keys(record).filter((key) => key !== "type").slice(0, 6);
  return keys.length ? `${type} (${keys.join(", ")})` : type;
}

export class ClaudeCodeHarness implements AgentHarness {
  readonly name = "claude-code" as const;
  readonly supportedProviders = CLAUDE_CODE_PROVIDERS;

  egressHosts(model: string): string[] {
    const provider = assertSupportedModel(this.name, this.supportedProviders, model);
    return [PROVIDER_HOSTS[provider] as string];
  }

  /** Configured entirely by env; there is no file to write. */
  configFile(): null {
    return null;
  }

  env(input: CodingTaskInput): Record<string, string> {
    const provider = assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return {
      [PROVIDER_KEY_ENV[provider] as string]: DUMMY_PROVIDER_KEY,
      // Non-interactive container: no telemetry, no update check mid-run.
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    };
  }

  buildArgv(input: CodingTaskInput, workdir: string): string[] {
    return [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      // Headless run: edit tools are auto-approved inside the sandbox, which is
      // the isolation boundary. Interactive prompting would hang the run.
      "--permission-mode",
      "acceptEdits",
      "--model",
      stripProvider(input.codingModel),
      "--add-dir",
      workdir,
      input.task,
    ];
  }

  parseEvent(line: string): string | null {
    return parseClaudeCodeEvent(line);
  }
}

/** The CLI takes a bare model id; the `provider/` prefix is ours. */
function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const claudeCodeHarness = new ClaudeCodeHarness();
