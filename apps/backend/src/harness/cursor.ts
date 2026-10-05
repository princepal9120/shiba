/**
 * Cursor harness — Cursor Agent CLI (`cursor-agent`) in ACP mode.
 *
 * `cursor-agent --force acp` serves Agent Client Protocol (JSON-RPC 2.0 over
 * newline-delimited stdio). The AgentHarness seam is a single shell exec, so
 * the ACP conversation runs inside the container in a small Node driver that
 * configFile() writes; it re-emits traffic as NDJSON that parseEvent() reads.
 *
 * Auth: the CLI reads CURSOR_API_KEY from env (no in-band `authenticate`).
 * The container holds the dummy key; the Worker's egress swaps the real one
 * in on api2.cursor.sh. Model "auto" is the CLI's own picker value and is
 * never sent to session/set_model.
 */
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import { ACP_DRIVER_SOURCE } from "./acp.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import { boundTail } from "../security.js";
import {
  assertSupportedModel,
  PROVIDER_HOSTS,
  PROVIDER_KEY_ENV,
  type AgentHarness,
  type HarnessConfigFile,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";

export const CURSOR_PROVIDERS = ["cursor"] as const;

/** api2 is the API plane; repo2 is the repo/context backend the CLI also calls. */
export const CURSOR_EGRESS_HOSTS = ["api2.cursor.sh", "repo2.cursor.sh"] as const;

/** Thrown when the driver reports an agent-side failure. */
export class CursorErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "CursorErrorEvent";
    this.detail = detail;
  }
}

export class CursorEventError extends Error {}

/** Deterministic driver path — buildArgv recomputes what configFile wrote. */
export function cursorDriverPath(sandboxId: string): string {
  return `/workspace/${sandboxId}.cursor-driver.cjs`;
}

/** Parse one NDJSON line the driver printed. `type:"error"` throws so the run fails honestly. */
export function parseCursorEvent(line: string): HarnessEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    throw new CursorEventError(`Unparseable Cursor event: ${boundTail(trimmed, 200)}`);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new CursorEventError("Cursor event is not an object.");
  }
  const record = event as Record<string, unknown>;
  if (record.type === "error") {
    const detail = typeof record.message === "string" ? record.message : JSON.stringify(record);
    throw new CursorErrorEvent(boundTail(detail, 500));
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  return text ? { kind: "text", text: boundTail(text, 500) } : null;
}

export class CursorHarness implements AgentHarness {
  readonly name = "cursor" as const;
  readonly supportedProviders = CURSOR_PROVIDERS;

  egressHosts(model: string): string[] {
    const provider = assertSupportedModel(this.name, this.supportedProviders, model);
    return [PROVIDER_HOSTS[provider] as string, CURSOR_EGRESS_HOSTS[1]];
  }

  /** The run config is embedded as a JSON literal — JSON is valid JS, so no escaping pass. */
  configFile(input: CodingTaskInput, sandboxId: string): HarnessConfigFile {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    const model = stripProvider(input.codingModel);
    const run = {
      argv: [...CURSOR_ACP_ARGV],
      model: model === "auto" ? null : model,
      task: input.task,
      label: "Cursor",
    };
    return {
      path: cursorDriverPath(sandboxId),
      contents: `"use strict";\nconst cfg = ${JSON.stringify(run)};\n${ACP_DRIVER_SOURCE}`,
    };
  }

  env(input: CodingTaskInput, _configPath: string | null = null): Record<string, string> {
    const provider = assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return { [PROVIDER_KEY_ENV[provider] as string]: DUMMY_PROVIDER_KEY };
  }

  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    return ["node", cursorDriverPath(input.sandboxId)];
  }

  parseEvent(line: string): HarnessEvent | null {
    return parseCursorEvent(line);
  }
  /** T43 declared capabilities — the gates read this, not the name. */
  capabilities(_model?: string): HarnessCapabilities {
    return { streamsText: true, emitsToolCalls: true, supportsResume: false, supportsSteering: false, supportsFileAttachments: false, canRunTests: false, supportsConversationRollback: false, execAllowlist: [],
      supportedRuntimes: [] };
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

/** Spawn argv for `cursor-agent --force acp` — embedded in the shared ACP driver's cfg. */
const CURSOR_ACP_ARGV = ["cursor-agent", "--force", "acp"] as const;

export const cursorHarness = new CursorHarness();
