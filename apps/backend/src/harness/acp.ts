/**
 * Shared ACP (Agent Client Protocol) transport for harnesses whose CLI speaks
 * JSON-RPC 2.0 over newline-delimited stdio instead of emitting a finished
 * event stream (t3code's Cursor/Grok pattern, without Effect).
 *
 * The AgentHarness seam is a single shell exec, so the ACP conversation —
 * initialize → authenticate → session/new → session/set_model →
 * session/prompt, with session/update notifications in between — runs inside
 * the container in a small Node driver script. {@link AcpHarness.configFile}
 * writes that driver into the workdir; it re-emits each event as one
 * normalized NDJSON line on stdout, which {@link AcpHarness.parseEvent} maps
 * to progress text like the stream-json harnesses.
 *
 * The credential invariant is unchanged: the container env carries
 * DUMMY_PROVIDER_KEY and the real credential is swapped in at the Worker's
 * egress boundary. The driver's in-band `authenticate` call therefore sends
 * the dummy key — it never sees a real one.
 */
import type { CodingTaskInput } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import { boundTail } from "../security.js";
import {
  assertSupportedModel,
  PROVIDER_HOSTS,
  PROVIDER_KEY_ENV,
  type AgentHarness,
  type AgentHarnessName,
  type HarnessConfigFile,
} from "./types.js";

/** Thrown when the ACP driver reports an agent-side failure. */
export class AcpErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "AcpErrorEvent";
    this.detail = detail;
  }
}

/** Thrown when a driver stdout line is not the NDJSON envelope it promised. */
export class AcpEventError extends Error {}

/** Per-CLI wiring an ACP-speaking harness needs beyond the shared driver. */
export interface AcpSupport {
  readonly name: AgentHarnessName;
  /** Binary inside the container, e.g. "cursor-agent". */
  readonly binary: string;
  /** Args that put the binary into ACP stdio mode, e.g. ["acp"]. */
  readonly acpArgv: readonly string[];
  /** Provider namespace codingModel must live in, e.g. "cursor". */
  readonly provider: string;
  /** Container env var that carries the (dummy) key, e.g. "CURSOR_API_KEY". */
  readonly keyEnv: string;
  /**
   * ACP `authenticate` methodId to invoke after initialize, or null when the
   * CLI authenticates purely from its env var (Cursor's CURSOR_API_KEY).
   */
  readonly authMethodId: string | null;
  /** Model ids that must NOT be sent to session/set_model (e.g. "auto"). */
  readonly cliManagedModels?: readonly string[];
  /** Additional hosts beyond PROVIDER_HOSTS[provider] (e.g. repo2.cursor.sh). */
  readonly extraEgressHosts?: readonly string[];
}

interface AcpRunConfig {
  command: string;
  args: string[];
  authMethodId: string | null;
  model: string | null;
  task: string;
}

/** Deterministic driver path — buildArgv recomputes what configFile wrote. */
export function acpDriverPath(sandboxId: string): string {
  return `/workspace/${sandboxId}.acp-driver.cjs`;
}

/** The "provider/model" → bare model id the ACP session/set_model call takes. */
export function acpModelId(codingModel: string): string {
  const slash = codingModel.indexOf("/");
  return slash > 0 ? codingModel.slice(slash + 1) : codingModel;
}

/**
 * Parse one normalized NDJSON line the driver printed. `type:"error"` throws
 * AcpErrorEvent so the run fails honestly; a malformed line throws
 * AcpEventError like the other harnesses' parse errors.
 */
export function parseAcpEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    throw new AcpEventError(`Unparseable ACP driver event: ${boundTail(trimmed, 200)}`);
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new AcpEventError("ACP driver event is not an object.");
  }
  const record = event as Record<string, unknown>;
  if (record.type === "error") {
    const detail = typeof record.message === "string" ? record.message : JSON.stringify(record);
    throw new AcpErrorEvent(boundTail(detail, 500));
  }
  const text = typeof record.text === "string" ? record.text : "";
  return boundTail(text.trim() || `acp:${String(record.type ?? "event")}`, 500);
}

export class AcpHarness implements AgentHarness {
  readonly name: AgentHarnessName;
  readonly supportedProviders: readonly string[];
  private readonly support: AcpSupport;

  constructor(support: AcpSupport) {
    this.support = support;
    this.name = support.name;
    this.supportedProviders = [support.provider];
  }

  egressHosts(model: string): string[] {
    const provider = assertSupportedModel(this.name, this.supportedProviders, model);
    const host = PROVIDER_HOSTS[provider];
    if (!host) throw new Error(`Provider ${JSON.stringify(provider)} has no known API host.`);
    return [host, ...(this.support.extraEgressHosts ?? [])];
  }

  /**
   * The in-container ACP client. The run config travels inside the file as a
   * JSON trailer — {@link configFile} returns exactly one file, so config and
   * driver ship together. The driver ignores everything after the marker.
   */
  configFile(input: CodingTaskInput, sandboxId: string): HarnessConfigFile {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    const model = acpModelId(input.codingModel);
    const cliManaged = this.support.cliManagedModels ?? [];
    const run: AcpRunConfig = {
      command: this.support.binary,
      args: [...this.support.acpArgv],
      authMethodId: this.support.authMethodId,
      model: model && !cliManaged.includes(model) ? model : null,
      task: input.task,
    };
    return {
      path: acpDriverPath(sandboxId),
      contents: `${ACP_DRIVER_SOURCE}\n//__ACP_RUN_CONFIG__\n${JSON.stringify(run)}\n`,
    };
  }

  env(input: CodingTaskInput, _configPath: string | null): Record<string, string> {
    const provider = assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    const env: Record<string, string> = {
      [this.support.keyEnv]: DUMMY_PROVIDER_KEY,
    };
    // PROVIDER_KEY_ENV may alias the same var (grok: XAI_API_KEY both ways) —
    // same dummy value either way, so the second write is a no-op.
    const providerEnv = PROVIDER_KEY_ENV[provider];
    if (providerEnv && providerEnv !== this.support.keyEnv) {
      env[providerEnv] = DUMMY_PROVIDER_KEY;
    }
    return env;
  }

  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return ["node", acpDriverPath(input.sandboxId)];
  }

  parseEvent(line: string): string | null {
    return parseAcpEvent(line);
  }
}

/**
 * The ACP client driver. Plain Node (>=18) CJS: spawn the CLI, speak
 * newline-delimited JSON-RPC on its stdio, normalize traffic to NDJSON on
 * stdout, exit 0 after session/prompt resolves, 1 on protocol failure.
 * No npm imports — the sandbox image only guarantees `node`.
 */
export const ACP_DRIVER_SOURCE = `#!/usr/bin/env node
/* ACP stdio driver — generated by harness/acp.ts. Not edited by hand. */
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const source = fs.readFileSync(__filename, "utf8");
const marker = "//__ACP_RUN_CONFIG__";
const cfg = JSON.parse(source.slice(source.indexOf(marker) + marker.length).trim());
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const fail = (msg) => { emit({ type: "error", message: String(msg).slice(0, 900) }); process.exit(1); };

const child = spawn(cfg.command, cfg.args, { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let nextId = 1;
const pending = new Map();
let sessionId = null;
let promptDone = false;

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function respond(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function respondError(id, code, message) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : "")).join("");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function onUpdate(params) {
  if (!params || typeof params !== "object") return;
  const u = params.update;
  if (!u || typeof u !== "object") return;
  const kind = u.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "user_message_chunk" || kind === "agent_thought_chunk") {
    const t = textOf(u.content);
    if (t) emit({ type: "message", text: t });
  } else if (kind === "tool_call") {
    emit({ type: "tool", text: "tool: " + String(u.title || u.kind || u.toolCallId || "call") });
  } else if (kind === "tool_call_update") {
    const st = typeof u.status === "string" ? "tool " + u.status : null;
    if (st) emit({ type: "tool", text: st });
  } else if (kind === "plan") {
    emit({ type: "message", text: "plan updated" });
  }
}

function onRequest(msg) {
  const m = msg.method;
  if (m === "session/request_permission") {
    const opts = (msg.params && msg.params.options) || [];
    const allow = opts.find((o) => o && /allow/i.test(String(o.kind || o.optionId || ""))) || opts[0];
    respond(msg.id, allow
      ? { outcome: { outcome: "selected", optionId: allow.optionId } }
      : { outcome: { outcome: "cancelled" } });
    return;
  }
  // fs/terminal/session extension requests the client cannot serve.
  respondError(msg.id, -32601, "client does not implement " + m);
}

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error((msg.error.message || "JSON-RPC error") + " (" + msg.error.code + ")"));
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.id !== undefined && typeof msg.method === "string") { onRequest(msg); return; }
  if (msg.method === "session/update") onUpdate(msg.params);
}

child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  for (;;) {
    const i = buf.indexOf("\\n");
    if (i < 0) break;
    onLine(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
child.on("error", (e) => fail("spawn failed: " + e.message));
child.on("exit", (code) => {
  if (!promptDone) fail("agent exited before the prompt completed (code " + code + ")");
});

(async () => {
  try {
    await send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "shiba-ai-coworker", version: "0.1.0" },
    });
    if (cfg.authMethodId) {
      await send("authenticate", { methodId: cfg.authMethodId });
    }
    const created = await send("session/new", { cwd: process.cwd(), mcpServers: [] });
    sessionId = created && created.sessionId;
    if (!sessionId) fail("session/new returned no sessionId");
    if (cfg.model) {
      try { await send("session/set_model", { sessionId, modelId: cfg.model }); }
      catch (e) { emit({ type: "message", text: "model selection refused: " + e.message }); }
    }
    const res = await send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: cfg.task }],
    });
    promptDone = true;
    emit({ type: "done", text: "stopReason: " + String((res && res.stopReason) || "end_turn") });
    child.stdin.end();
    child.kill("SIGTERM");
    process.exit(0);
  } catch (e) {
    fail(e && e.message ? e.message : e);
  }
})();
`;
