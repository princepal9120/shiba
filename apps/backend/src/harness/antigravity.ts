/**
 * Antigravity harness — Google's `agy` CLI (Gemini CLI successor).
 *
 * Headless like OpenCode: one exec that prints and exits. The flag surface
 * is not fully documented yet, so argv stays minimal and parseEvent accepts
 * both JSON lines and plain text.
 *
 * Auth/egress: the container gets the dummy GOOGLE_GENERATIVE_AI_API_KEY;
 * the Worker's egress swaps the real key in on generativelanguage.googleapis.com.
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

export const ANTIGRAVITY_PROVIDERS = ["google"] as const;

/** Thrown when agy reports an error event. */
export class AntigravityErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "AntigravityErrorEvent";
    this.detail = detail;
  }
}

/** JSON lines surface their text/message field; anything else is plain progress text. */
export function parseAntigravityEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return boundTail(trimmed, 500);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return boundTail(trimmed, 500);
  }
  const record = event as Record<string, unknown>;
  if (record.type === "error") {
    const detail = typeof record.message === "string" ? record.message : JSON.stringify(record);
    throw new AntigravityErrorEvent(boundTail(detail, 500));
  }
  const text = typeof record.text === "string"
    ? record.text
    : typeof record.message === "string"
      ? record.message
      : typeof record.content === "string"
        ? record.content
        : "";
  return text.trim() ? boundTail(text.trim(), 500) : null;
}

export class AntigravityHarness implements AgentHarness {
  readonly name = "antigravity" as const;
  readonly supportedProviders = ANTIGRAVITY_PROVIDERS;

  egressHosts(model: string): string[] {
    const provider = assertSupportedModel(this.name, this.supportedProviders, model);
    return [PROVIDER_HOSTS[provider] as string];
  }

  /** Configured entirely by env and argv. */
  configFile(): null {
    return null;
  }

  env(input: CodingTaskInput, _configPath: string | null = null): Record<string, string> {
    const provider = assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return { [PROVIDER_KEY_ENV[provider] as string]: DUMMY_PROVIDER_KEY };
  }

  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    return [
      "agy",
      "--no-interactive",
      // Headless: tool calls auto-approve; the sandbox is the isolation boundary.
      "--yolo",
      "--model",
      stripProvider(input.codingModel),
      input.task,
    ];
  }

  parseEvent(line: string): string | null {
    return parseAntigravityEvent(line);
  }
}

/** The CLI takes a bare model id; the `provider/` prefix is ours. */
function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const antigravityHarness = new AntigravityHarness();
