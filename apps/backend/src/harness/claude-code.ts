/**
 * Claude Code harness (PLAN.md T22).
 *
 * API-key only — this harness is scoped to the gateway/BYOK path (PLAN.md
 * §3). Subscription credentials (`claude setup-token`) are a *separate*
 * harness — claude-subscription.ts (T48/§18.10) — carrying their own
 * egress branch, opt-in gate, and terms note, never a mode flag here.
 * The container gets the dummy key; the real one is injected at the
 * egress boundary.
 */
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import { boundTail } from "../security.js";
import {
  assertSupportedModel,
  PROVIDER_HOSTS,
  PROVIDER_KEY_ENV,
  type AgentHarness,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
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
export function parseClaudeCodeEvent(line: string): HarnessEvent | null {
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
  return claudeCodeEvent(record);
}

function claudeCodeEvent(record: Record<string, unknown>): HarnessEvent {
  const message = record.message;
  if (typeof message === "object" && message !== null) {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      const tools: string[] = [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null) continue;
        const block = entry as Record<string, unknown>;
        if (typeof block.text === "string") parts.push(block.text);
        else if (typeof block.name === "string") {
          parts.push(`tool: ${block.name}`);
          tools.push(block.name);
        }
      }
      if (tools.length > 0) {
        return { kind: "tool", name: tools.join(", "), text: boundTail(parts.join(" ").trim(), 500) };
      }
      if (parts.length > 0) {
        return { kind: "text", text: boundTail(parts.join(" ").trim(), 500) };
      }
    }
  }
  if (typeof record.result === "string" && record.result.trim()) {
    return { kind: "result", text: boundTail(record.result.trim(), 500) };
  }
  const type = typeof record.type === "string" ? record.type : "event";
  const keys = Object.keys(record).filter((key) => key !== "type").slice(0, 6);
  return { kind: "progress", text: boundTail(keys.length ? `${type} (${keys.join(", ")})` : type, 500) };
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

  parseEvent(line: string): HarnessEvent | null {
    return parseClaudeCodeEvent(line);
  }
  /** T43 declared capabilities — the gates read this, not the name. */
  capabilities(_model?: string): HarnessCapabilities {
    return { streamsText: true, emitsToolCalls: true, supportsResume: true, supportsSteering: false, supportsFileAttachments: false, canRunTests: true, supportsConversationRollback: false, execAllowlist: [["pnpm","test"],["npm","test"],["bun","test"],["pnpm","vitest","run"],["npx","vitest","run"]],
      supportedRuntimes: ["sandbox", "local"] };
  }

  /** Deterministic outcome check — gates the completed claim (T43/T46 feed). */
  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }

}

/** The CLI takes a bare model id; the `provider/` prefix is ours. */
function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const claudeCodeHarness = new ClaudeCodeHarness();
