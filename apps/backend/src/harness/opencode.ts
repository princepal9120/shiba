/**
 * OpenCode harness (PLAN.md T21).
 *
 * The pre-refactor OpenCode logic moved verbatim behind the AgentHarness
 * interface: config, argv, and event parsing. No behavior change — the
 * runtime adapter owns clone, collect, diff, publish, progress fractions,
 * and the container env. A second harness (T22) implements AgentHarness
 * beside this one; nothing here is OpenCode-specific by accident.
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
  type HarnessConfigFile,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import type { RunUsage } from "@shiba/shared";

/** OpenCode is multi-provider; the gateway decides which are actually reachable. */
export const OPENCODE_PROVIDERS = ["google", "anthropic", "openai", "xai", "opencode-go"] as const;

/** Thrown when a streamed OpenCode event line is malformed. */
export class OpenCodeEventError extends Error {}

/** Thrown when OpenCode emits an error event (type=error). */
export class OpenCodeErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "OpenCodeErrorEvent";
    this.detail = detail;
  }
}

/**
 * Parse one `--format json` event line into progress text. OpenCode emits
 * newline-delimited JSON; anything else is surfaced as an honest error.
 * Error events throw OpenCodeErrorEvent so callers can propagate them.
 */
export function parseOpencodeEvent(line: string): HarnessEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    throw new OpenCodeEventError(`Unparseable OpenCode event: ${boundTail(trimmed, 200)}`);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new OpenCodeEventError("OpenCode event is not an object.");
  }
  const record = event as Record<string, unknown>;
  if (record.type === "error") {
    const detail = typeof record.message === "string" ? record.message : JSON.stringify(record);
    throw new OpenCodeErrorEvent(boundTail(detail, 500));
  }
  const part = record.part ?? record.parts;
  if (record.type === "step_finish" && typeof part === "object" && part !== null) {
    const usage = stepFinishUsage(part as Record<string, unknown>);
    if (usage !== undefined) {
      return { kind: "usage", usage, text: describeUsage(usage) };
    }
  }
  if (typeof part === "string" && part.trim()) {
    return { kind: "text", text: boundTail(part.trim(), 500) };
  }
  return { kind: "progress", text: boundTail(summarizeUnknown(record), 500) };
}

/**
 * `step_finish` parts carry the step's token counts and USD cost — a delta,
 * so the collector sums them. `input` excludes prompt-cache traffic, so
 * cache reads/writes are folded into inputTokens; reasoning tokens are
 * output-side. Fields the CLI didn't emit stay absent.
 */
function stepFinishUsage(part: Record<string, unknown>): RunUsage | undefined {
  const tokens = part.tokens;
  const usage: RunUsage = {};
  if (typeof tokens === "object" && tokens !== null) {
    const counts = tokens as Record<string, unknown>;
    const num = (key: string): number =>
      typeof counts[key] === "number" && Number.isFinite(counts[key] as number) ? (counts[key] as number) : 0;
    const cache = typeof counts.cache === "object" && counts.cache !== null
      ? (counts.cache as Record<string, unknown>)
      : {};
    const cacheNum = (key: string): number =>
      typeof cache[key] === "number" && Number.isFinite(cache[key] as number) ? (cache[key] as number) : 0;
    const input = num("input") + cacheNum("read") + cacheNum("write");
    const output = num("output") + num("reasoning");
    if (input > 0) usage.inputTokens = input;
    if (output > 0) usage.outputTokens = output;
  }
  if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0) {
    usage.costUsd = part.cost;
  }
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.costUsd !== undefined
    ? usage
    : undefined;
}

function summarizeUnknown(record: Record<string, unknown>): string {
  const type = typeof record.type === "string" ? record.type : "event";
  const keys = Object.keys(record).filter((key) => key !== "type" && key !== "part").slice(0, 6);
  return keys.length ? `${type} (${keys.join(", ")})` : type;
}

/**
 * OpenCode uses the native Google endpoint with a dummy key. Sandbox HTTPS
 * egress rewrites provider requests to AI Gateway outside the container.
 * Only the allow-listed provider is enabled.
 */
export function buildOpencodeConfig(input: CodingTaskInput): Record<string, unknown> {
  const model = input.codingModel;
  const provider = assertSupportedModel("opencode", OPENCODE_PROVIDERS, model);
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    // Only the provider actually in use; every other one stays off.
    enabled_providers: [provider],
    autoupdate: false,
    provider: {
      [provider]: {
        options: {
          apiKey: DUMMY_PROVIDER_KEY,
        },
      },
    },
  };
}

/**
 * argv for a headless JSON-event run. Callers must quote with shellJoin;
 * never interpolate the task into a shell string by hand.
 */
export function buildOpencodeArgv(input: CodingTaskInput, workdir: string): string[] {
  return [
    "opencode",
    "run",
    "--format",
    "json",
    "--model",
    input.codingModel,
    "--dir",
    workdir,
    input.task,
  ];
}

export class OpenCodeHarness implements AgentHarness {
  readonly name = "opencode" as const;
  readonly supportedProviders = OPENCODE_PROVIDERS;

  egressHosts(model: string): string[] {
    const provider = assertSupportedModel(this.name, this.supportedProviders, model);
    return [PROVIDER_HOSTS[provider] as string];
  }

  configFile(input: CodingTaskInput, sandboxId: string): HarnessConfigFile {
    return {
      path: `/workspace/${sandboxId}.opencode.json`,
      contents: JSON.stringify(buildOpencodeConfig(input), null, 2),
    };
  }

  env(input: CodingTaskInput, configPath: string | null): Record<string, string> {
    const provider = assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return {
      ...(configPath ? { OPENCODE_CONFIG: configPath } : {}),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      [PROVIDER_KEY_ENV[provider] as string]: DUMMY_PROVIDER_KEY,
    };
  }

  buildConfig(input: CodingTaskInput): Record<string, unknown> {
    return buildOpencodeConfig(input);
  }

  buildArgv(input: CodingTaskInput, workdir: string): string[] {
    return buildOpencodeArgv(input, workdir);
  }

  parseEvent(line: string): HarnessEvent | null {
    return parseOpencodeEvent(line);
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

export const opencodeHarness = new OpenCodeHarness();
