/**
 * Agent Client Protocol harnesses — any agent that speaks ACP (JSON-RPC 2.0
 * over newline-delimited stdio) runs in the sandbox through the shared
 * driver below. This is the same transport cursor.ts uses for
 * `cursor-agent --force acp`; here the spawn command is a spec parameter so
 * every registry-listed ACP agent becomes a first-class harness:
 *
 *   claude-acp   → `claude-agent-acp`      (@agentclientprotocol/claude-agent-acp, Apache-2.0)
 *   codex-acp    → `codex-acp`             (@agentclientprotocol/codex-acp, Apache-2.0)
 *   gemini-acp   → `gemini --acp`          (@google/gemini-cli, Apache-2.0)
 *   opencode-acp → `opencode acp`          (installed opencode, MIT)
 *   devin-acp    → `devin acp`             (installed Devin CLI ≥3000.11.3)
 *
 * The credential invariant is unchanged: the container only ever sees the
 * dummy key (PROVIDER_KEY_ENV or the spec's keyEnv), and the Worker's egress
 * boundary attaches the real credential. The ACP session's model is set via
 * session/set_model with the provider prefix stripped — `provider/model`
 * stays our routing vocabulary, never the agent's.
 *
 * Capabilities are declared honestly: ACP gives streaming text, tool-call
 * and plan updates, and permission requests (auto-allowed inside the
 * container, same as the cursor driver). No steering/resume is wired —
 * the one-shot prompt contract stands.
 */
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import { boundTail } from "../security.js";
import {
  assertSupportedModel,
  PROVIDER_HOSTS,
  PROVIDER_KEY_ENV,
  type AgentHarness,
  type AgentHarnessName,
  type HarnessConfigFile,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";

/** Everything an ACP harness differs in. */
export interface AcpHarnessSpec {
  readonly name: AgentHarnessName;
  /** Human label for error text, e.g. "Claude ACP". */
  readonly label: string;
  /** The argv that launches the agent's ACP server on stdio. */
  readonly spawn: readonly string[];
  /** Provider ids this agent can drive (`provider/model` prefixes). */
  readonly providers: readonly string[];
  /**
   * Env var the agent reads for its API key. Defaults to
   * `PROVIDER_KEY_ENV[provider]` — override when the CLI listens on a
   * different variable than the provider's standard (gemini-cli reads
   * GEMINI_API_KEY, not GOOGLE_GENERATIVE_AI_API_KEY).
   */
  readonly keyEnv?: string;
  /** Non-provider hosts the agent also needs (auth planes, telemetry). */
  readonly extraEgress?: readonly string[];
  /**
   * Transform `provider/model` into the id this agent's ACP server expects.
   * Default strips the provider prefix (`anthropic/claude-x` → `claude-x`);
   * OpenCode's ACP model grammar is `provider/model[/variant]`, so its lane
   * passes the id through unchanged.
   */
  readonly modelId?: (model: string) => string;
  /**
   * Extra config files the agent's CLI needs (credentials.toml,
   * opencode.json). They are emitted before the driver file in the
   * configFile array so `env(configPath)` names the agent's own config,
   * matching how OpenCodeHarness/DevinHarness wire OPENCODE_CONFIG and
   * XDG_DATA_HOME.
   */
  readonly extraConfig?: (input: CodingTaskInput, sandboxId: string) => HarnessConfigFile[];
  /**
   * Extra env beyond the dummy provider key. Receives the same arguments
   * as env() — `configPath` is the first emitted file's path.
   */
  readonly extraEnv?: (input: CodingTaskInput, configPath: string | null) => Record<string, string>;
}

export class AcpEventError extends Error {
  constructor(detail: string, agent: string) {
    super(detail);
    this.name = `${agent}EventError`;
  }
}

/** Thrown when the driver reports an agent-side failure. */
export class AcpErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string, agent: string) {
    super(detail);
    this.name = `${agent}ErrorEvent`;
    this.detail = detail;
  }
}

/** Deterministic driver path — configFile() writes what buildArgv runs. */
export function acpDriverPath(sandboxId: string): string {
  return `/workspace/${sandboxId}.acp-driver.cjs`;
}

/** Parse one NDJSON line the shared driver printed. */
export function parseAcpDriverEvent(line: string, agent: string): HarnessEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    throw new AcpEventError(`Unparseable ${agent} event: ${boundTail(trimmed, 200)}`, agent);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new AcpEventError(`${agent} event is not an object.`, agent);
  }
  const record = event as Record<string, unknown>;
  if (record.type === "error") {
    const detail = typeof record.message === "string" ? record.message : JSON.stringify(record);
    throw new AcpErrorEvent(boundTail(detail, 500), agent);
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  return text ? { kind: "text", text: boundTail(text, 500) } : null;
}

export class AcpHarness implements AgentHarness {
  constructor(private readonly spec: AcpHarnessSpec) {}

  get name(): AgentHarnessName {
    return this.spec.name;
  }

  get supportedProviders(): readonly string[] {
    return this.spec.providers;
  }

  egressHosts(model: string): string[] {
    const provider = assertSupportedModel(this.name, this.spec.providers, model);
    return [PROVIDER_HOSTS[provider] as string, ...(this.spec.extraEgress ?? [])];
  }

  configFile(input: CodingTaskInput, sandboxId: string): HarnessConfigFile | HarnessConfigFile[] {
    assertSupportedModel(this.name, this.spec.providers, input.codingModel);
    const model = this.spec.modelId
      ? this.spec.modelId(input.codingModel)
      : stripProvider(input.codingModel);
    const run = {
      argv: this.spec.spawn,
      model: model === "auto" ? null : model,
      task: input.task,
      label: this.spec.label,
    };
    const driver: HarnessConfigFile = {
      path: acpDriverPath(sandboxId),
      // The run config is embedded as a JSON literal — JSON is valid JS.
      contents: `"use strict";\nconst cfg = ${JSON.stringify(run)};\n${ACP_DRIVER_SOURCE}`,
    };
    const extras = this.spec.extraConfig?.(input, sandboxId) ?? [];
    return extras.length ? [...extras, driver] : driver;
  }

  env(input: CodingTaskInput, configPath: string | null = null): Record<string, string> {
    const provider = assertSupportedModel(this.name, this.spec.providers, input.codingModel);
    return {
      [this.spec.keyEnv ?? (PROVIDER_KEY_ENV[provider] as string)]: DUMMY_PROVIDER_KEY,
      ...(this.spec.extraEnv?.(input, configPath) ?? {}),
    };
  }

  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    return ["node", acpDriverPath(input.sandboxId)];
  }

  parseEvent(line: string): HarnessEvent | null {
    return parseAcpDriverEvent(line, this.spec.label);
  }

  capabilities(_model?: string): HarnessCapabilities {
    return {
      streamsText: true,
      emitsToolCalls: true,
      supportsResume: false,
      supportsSteering: false,
      supportsFileAttachments: false,
      canRunTests: false,
      supportsConversationRollback: false,
      execAllowlist: [],
      supportedRuntimes: ["sandbox"],
    };
  }

  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

/** `provider/model` → bare model id; the ACP server takes its own id form. */
function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/**
 * The one-shot ACP client: initialize → session/new → set_model → prompt.
 * Re-emits session updates as NDJSON ({type, text}) the harness's
 * parseEvent reads; session/request_permission auto-picks an "allow"
 * option (the agent's own container sandbox is the boundary). Plain Node
 * CJS, no npm imports — the sandbox image only guarantees `node`.
 */
export const ACP_DRIVER_SOURCE = `const { spawn } = require("node:child_process");

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const fail = (msg) => {
  // Kill the agent before exiting: an ACP server left running could keep
  // mutating the worktree after the run is already marked failed.
  try { child.kill("SIGKILL"); } catch (_) { /* spawn may never have started */ }
  emit({ type: "error", message: String(msg).slice(0, 900) });
  process.exit(1);
};

const child = spawn(cfg.argv[0], cfg.argv.slice(1), { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let nextId = 1;
const pending = new Map();
let promptDone = false;

const write = (o) => child.stdin.write(JSON.stringify(Object.assign({ jsonrpc: "2.0" }, o)) + "\\n");
function send(method, params) {
  const id = nextId++;
  write({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function onUpdate(u) {
  if (!u || typeof u !== "object") return;
  const kind = u.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "user_message_chunk" || kind === "agent_thought_chunk") {
    const t = textOf(u.content);
    if (t) emit({ type: kind, text: t });
  } else if (kind === "tool_call") {
    emit({ type: kind, text: "tool: " + String(u.title || u.kind || u.toolCallId || "call") });
  } else if (kind === "tool_call_update") {
    if (typeof u.status === "string") emit({ type: kind, text: "tool " + u.status });
  } else if (kind === "plan") {
    emit({ type: kind, text: "plan updated" });
  }
}

function onRequest(msg) {
  if (msg.method === "session/request_permission") {
    const opts = (msg.params && msg.params.options) || [];
    const allow = opts.find((o) => o && /allow/i.test(String(o.kind || o.optionId || "")));
    write({ id: msg.id, result: allow
      ? { outcome: { outcome: "selected", optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" } } });
    return;
  }
  // fs/terminal requests: clientCapabilities advertised none of them.
  write({ id: msg.id, error: { code: -32601, message: "client does not implement " + msg.method } });
}

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error((msg.error.message || "JSON-RPC error") + " (" + msg.error.code + ")"));
    else p.resolve(msg.result);
  } else if (msg.id !== undefined && typeof msg.method === "string") {
    onRequest(msg);
  } else if (msg.method === "session/update") {
    onUpdate(msg.params && msg.params.update);
  }
}

child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    onLine(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
child.on("error", (e) => fail("spawn failed: " + e.message));
child.on("exit", (code) => { if (!promptDone) fail(cfg.label + " exited before the prompt completed (code " + code + ")"); });

(async () => {
  try {
    await send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "shiba-ai-coworker", version: "0.1.0" },
    });
    const created = await send("session/new", { cwd: process.cwd(), mcpServers: [] });
    const sessionId = created && created.sessionId;
    if (!sessionId) fail("session/new returned no sessionId");
    if (cfg.model) await send("session/set_model", { sessionId, modelId: cfg.model });
    const res = await send("session/prompt", { sessionId, prompt: [{ type: "text", text: cfg.task }] });
    promptDone = true;
    const reason = String((res && res.stopReason) || "end_turn");
    if (reason !== "end_turn") fail(cfg.label + " stopped before finishing: " + reason);
    emit({ type: "done", text: "stopReason: " + reason });
    child.kill("SIGTERM");
    process.exit(0);
  } catch (e) {
    fail(e && e.message ? e.message : e);
  }
})();
`;
