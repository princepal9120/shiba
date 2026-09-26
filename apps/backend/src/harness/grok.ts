/**
 * Grok harness (PLAN.md T22) — xAI's Grok CLI (`grok`, npm @xai-official/grok).
 *
 * Headless: `grok --single <task>` prints the result and exits; the agent
 * loop still runs its tool set inside that prompt. `--output-format
 * streaming-json` emits flat type-tagged NDJSON lines and
 * `--permission-mode bypassPermissions` keeps tool execution
 * non-interactive — the Cloudflare Sandbox is the isolation boundary
 * (t3code's "full-access" runtime mode; `auto` would route tool calls
 * through a classifier that can block them).
 *
 * Auth/egress: the container gets the dummy XAI_API_KEY; the CLI's default
 * inference host is cli-chat-proxy.grok.com, so GROK_MODELS_BASE_URL pins it
 * to api.x.ai — the host the Worker's forwardXAI already mediates.
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

export const GROK_PROVIDERS = ["xai"] as const;

/** Thrown when Grok reports an error in its streaming-json output. */
export class GrokErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "GrokErrorEvent";
    this.detail = detail;
  }
}

export class GrokEventError extends Error {}

/**
 * Parse one `--output-format streaming-json` line. The stream is flat
 * type-tagged NDJSON — {type:"text",data}, {type:"thought",data},
 * {type:"tool_call",title,kind,status}, plus plan/usage/end/error. Error
 * types throw so a rejected model or aborted turn fails the run honestly
 * instead of reporting success.
 */
export function parseGrokEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    throw new GrokEventError(`Unparseable Grok event: ${boundTail(trimmed, 200)}`);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new GrokEventError("Grok event is not an object.");
  }
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  switch (type) {
    case "error": {
      const detail = typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : JSON.stringify(record);
      throw new GrokErrorEvent(boundTail(detail, 500));
    }
    case "max_turns_reached":
      throw new GrokErrorEvent("Grok hit its turn cap without finishing.");
    case "end": {
      // end_turn is the only clean stop; refusal, max_tokens,
      // max_turn_requests and cancelled all mean the task did not finish.
      const reason = typeof record.stopReason === "string" ? record.stopReason : "";
      if (reason !== "end_turn") {
        throw new GrokErrorEvent(`Grok stopped before finishing: ${reason}.`);
      }
      return null;
    }
    case "text":
    case "thought": {
      const data = record.data;
      return typeof data === "string" && data.trim() ? boundTail(data, 500) : null;
    }
    case "tool_call": {
      const title = typeof record.title === "string" && record.title
        ? record.title
        : typeof record.toolName === "string" && record.toolName
          ? record.toolName
          : "tool";
      return `tool: ${title}`;
    }
    default:
      // available_commands, tool_call_update, plan, usage, session bootstrap —
      // no progress text worth surfacing.
      return null;
  }
}

export class GrokHarness implements AgentHarness {
  readonly name = "grok" as const;
  readonly supportedProviders = GROK_PROVIDERS;

  egressHosts(model: string): string[] {
    const provider = assertSupportedModel(this.name, this.supportedProviders, model);
    return [PROVIDER_HOSTS[provider] as string];
  }

  /** Configured entirely by env; there is no file to write. */
  configFile(): null {
    return null;
  }

  env(input: CodingTaskInput, _configPath: string | null = null): Record<string, string> {
    const provider = assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return {
      [PROVIDER_KEY_ENV[provider] as string]: DUMMY_PROVIDER_KEY,
      // The CLI defaults to cli-chat-proxy.grok.com — pin it onto the
      // forwarder the Worker already mediates so the egress swap applies.
      GROK_MODELS_BASE_URL: `https://${PROVIDER_HOSTS.xai}/v1`,
      // Non-interactive container: no telemetry, feedback, or trace upload.
      GROK_TELEMETRY_ENABLED: "0",
      GROK_TELEMETRY_TRACE_UPLOAD: "0",
      GROK_FEEDBACK_ENABLED: "0",
    };
  }

  buildArgv(input: CodingTaskInput, workdir: string): string[] {
    return [
      "grok",
      "--single",
      input.task,
      "--output-format",
      "streaming-json",
      // Headless run: tool executions are always approved inside the sandbox,
      // which is the isolation boundary — `auto` routes calls through a
      // classifier that can block them unpredictably.
      "--permission-mode",
      "bypassPermissions",
      "--model",
      stripProvider(input.codingModel),
      "--reasoning-effort",
      "medium",
      "--cwd",
      workdir,
    ];
  }

  parseEvent(line: string): string | null {
    return parseGrokEvent(line);
  }
}

/** The CLI takes a bare model id; the `provider/` prefix is ours. */
function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const grokHarness = new GrokHarness();
