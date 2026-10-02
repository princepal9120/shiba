/**
 * Codex harness (PLAN.md T22).
 *
 * API-key only, for the same reason as Claude Code: no subscription
 * credentials are proxied. The container gets the dummy key; the real one is
 * injected at the egress boundary.
 */
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import { boundTail } from "../security.js";
import {
  assertSupportedModel,
  describeUsage,
  PROVIDER_HOSTS,
  PROVIDER_KEY_ENV,
  type AgentHarness,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import type { RunUsage } from "@shiba/shared";

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
export function parseCodexEvent(line: string): HarnessEvent | null {
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
      : "";
  if (text) return { kind: "text", text: boundTail(text, 500) };
  if (record.type === "turn.completed") {
    // turn.completed carries the turn's cumulative usage block — the
    // run's whole token spend in one report.
    const usage = turnUsage(record.usage);
    if (usage !== undefined) {
      return { kind: "usage", cumulative: true, usage, text: describeUsage(usage) };
    }
  }
  return { kind: "progress", text: boundTail(summarize(record), 500) };
}

/**
 * `input_tokens` excludes cached traffic — fold cached reads/writes into
 * input; reasoning tokens are output-side. Codex reports no USD figure, so
 * costUsd stays absent.
 */
function turnUsage(usage: unknown): RunUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  const num = (key: string): number | undefined =>
    typeof record[key] === "number" && Number.isFinite(record[key] as number) ? (record[key] as number) : undefined;
  const input = num("input_tokens");
  const cached = num("cached_input_tokens");
  const cacheWrite = num("cache_write_input_tokens");
  const output = num("output_tokens");
  const reasoning = num("reasoning_output_tokens");
  const parsed: RunUsage = {};
  if (input !== undefined || cached !== undefined || cacheWrite !== undefined) {
    parsed.inputTokens = (input ?? 0) + (cached ?? 0) + (cacheWrite ?? 0);
  }
  if (output !== undefined || reasoning !== undefined) {
    parsed.outputTokens = (output ?? 0) + (reasoning ?? 0);
  }
  return parsed.inputTokens !== undefined || parsed.outputTokens !== undefined ? parsed : undefined;
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

  parseEvent(line: string): HarnessEvent | null {
    return parseCodexEvent(line);
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

export const codexHarness = new CodexHarness();
