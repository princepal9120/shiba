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
    const run = { model: model === "auto" ? null : model, task: input.task };
    return {
      path: cursorDriverPath(sandboxId),
      contents: `"use strict";\nconst cfg = ${JSON.stringify(run)};\n${CURSOR_DRIVER_SOURCE}`,
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

/**
 * Plain Node CJS, no npm imports — the sandbox image only guarantees `node`.
 * Exported for cursor-subscription, which writes the identical driver file.
 */
export const CURSOR_DRIVER_SOURCE = `const { spawn } = require("node:child_process");

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const fail = (msg) => { emit({ type: "error", message: String(msg).slice(0, 900) }); process.exit(1); };

const child = spawn("cursor-agent", ["--force", "acp"], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "inherit"] });
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
    const allow = opts.find((o) => o && /allow/i.test(String(o.kind || o.optionId || ""))) || opts[0];
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
child.on("exit", (code) => { if (!promptDone) fail("agent exited before the prompt completed (code " + code + ")"); });

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
    if (reason !== "end_turn") fail("Cursor stopped before finishing: " + reason);
    emit({ type: "done", text: "stopReason: " + reason });
    child.kill("SIGTERM");
    process.exit(0);
  } catch (e) {
    fail(e && e.message ? e.message : e);
  }
})();
`;

export const cursorHarness = new CursorHarness();
