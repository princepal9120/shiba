/**
 * Codex harness (PLAN.md T22).
 *
 * API-key only, for the same reason as Claude Code: no subscription
 * credentials are proxied. The container gets the dummy key; the real one is
 * injected at the egress boundary.
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

export const CODEX_PROVIDERS = ["openai"] as const;

export class CodexErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "CodexErrorEvent";
    this.detail = detail;
  }
}

export class CodexEventError extends Error {}

/**
 * Parse one `codex exec --json` line. Error envelopes throw so a failed run
 * cannot be reported as a successful one.
 */
export function parseCodexEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    throw new CodexEventError(`Unparseable Codex event: ${boundTail(trimmed, 200)}`);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new CodexEventError("Codex event is not an object.");
  }
  const record = event as Record<string, unknown>;
  if (record.type === "error" || typeof record.error === "string") {
    const detail = typeof record.error === "string"
      ? record.error
      : typeof record.message === "string"
        ? record.message
        : JSON.stringify(record);
    throw new CodexErrorEvent(boundTail(detail, 500));
  }
  const text = typeof record.text === "string" && record.text.trim()
    ? record.text.trim()
    : typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : summarize(record);
  return boundTail(text, 500);
}

function summarize(record: Record<string, unknown>): string {
  const type = typeof record.type === "string" ? record.type : "event";
  const keys = Object.keys(record).filter((key) => key !== "type").slice(0, 6);
  return keys.length ? `${type} (${keys.join(", ")})` : type;
}

export class CodexHarness implements AgentHarness {
  readonly name = "codex" as const;
  readonly supportedProviders = CODEX_PROVIDERS;

  egressHosts(model: string): string[] {
    const provider = assertSupportedModel(this.name, this.supportedProviders, model);
    return [PROVIDER_HOSTS[provider] as string];
  }

  configFile(): null {
    return null;
  }

  env(input: CodingTaskInput): Record<string, string> {
    const provider = assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return { [PROVIDER_KEY_ENV[provider] as string]: DUMMY_PROVIDER_KEY };
  }

  buildArgv(input: CodingTaskInput, workdir: string): string[] {
    return [
      "codex",
      "exec",
      "--json",
      "--model",
      stripProvider(input.codingModel),
      "--cd",
      workdir,
      input.task,
    ];
  }

  parseEvent(line: string): string | null {
    return parseCodexEvent(line);
  }
}

/** The CLI takes a bare model id; the `provider/` prefix is ours. */
function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const codexHarness = new CodexHarness();
