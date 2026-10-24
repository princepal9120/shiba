/**
 * Provider-agnostic agent session layer (t3code's provider adapter, scaled
 * to Shiba). Codex speaks JSON-RPC to `codex app-server`. Claude Code speaks
 * stream-json on stdin/stdout. Both emit the same events, approvals,
 * checkpoints, and diffs.
 *
 * Imported by scripts/shiba-local-daemon.mjs. The sandbox runner writes this
 * same file into the container and executes it (`node harness.mjs job.json`).
 * No npm dependencies.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHECKPOINT_PREFIX = "refs/shiba/checkpoints/";

/** @typedef {"approval-required" | "accept-edits" | "plan" | "bypass"} PermissionMode */
/** @typedef {"codex" | "claude"} ProviderName */

/**
 * @typedef {object} SessionEvent
 * @property {string} type
 * @property {string} [text]
 * @property {string} [name]
 * @property {string} [requestId]
 * @property {string} [kind]
 * @property {string} [title]
 * @property {string} [detail]
 * @property {string} [decision]
 * @property {string} [status]
 * @property {string} [summary]
 * @property {string} [threadId]
 * @property {string} [turnId]
 * @property {string} [ref]
 * @property {string} [patch]
 * @property {string} [message]
 * @property {string} [sessionId]
 */

/**
 * @param {SessionEvent} event
 */
export function eventText(event) {
  switch (event.type) {
    case "message.delta":
    case "message.completed":
      return event.text ?? "";
    case "tool.started":
      return `tool: ${event.name ?? "tool"}`;
    case "tool.completed":
      return `tool done: ${event.name ?? "tool"}`;
    case "approval.requested":
      return `approval: ${event.title ?? event.kind ?? "request"}`;
    case "approval.resolved":
      return `approval ${event.decision ?? "pending"}`;
    case "diff.updated":
      return "diff updated";
    case "checkpoint.captured":
      return `checkpoint ${event.ref ?? ""}`.trim();
    case "turn.started":
      return "turn started";
    case "turn.completed":
      return event.summary || event.status || "turn completed";
    case "error":
      return event.message ?? "error";
    case "thread.updated":
      return event.threadId ? `thread ${event.threadId}` : "thread updated";
    default:
      return event.type;
  }
}

/**
 * @param {string} line
 * @returns {SessionEvent | null}
 */
export function parseSessionLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const record = JSON.parse(trimmed);
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  if (record.type !== "shiba.event" || record.event === null || typeof record.event !== "object") {
    return null;
  }
  return record.event;
}

function bound(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * @param {PermissionMode} mode
 */
function codexPolicy(mode) {
  switch (mode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly" },
      };
    case "plan":
      return {
        approvalPolicy: "on-request",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly" },
      };
    case "bypass":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    default:
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite" },
      };
  }
}

/**
 * @param {PermissionMode} mode
 */
function claudePermissionMode(mode) {
  switch (mode) {
    case "approval-required":
      return "default";
    case "plan":
      return "plan";
    case "bypass":
      return "bypassPermissions";
    default:
      return "acceptEdits";
  }
}

/**
 * @param {PermissionMode} mode
 * @param {{ kind: string, name?: string }} request
 */
function autoDecision(mode, request) {
  if (mode === "plan") {
    const name = request.name ?? "";
    if (request.kind === "command" || request.kind === "file_change") return "deny";
    if (name === "Read" || name === "Grep" || name === "Glob") return "allow";
    return "deny";
  }
  if (mode === "approval-required") return null;
  return "allow";
}

function git(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args[0]} failed: ${stderr.slice(-500)}`));
      else resolve(stdout);
    });
  });
}

function checkpointRef(sessionId, seq) {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${CHECKPOINT_PREFIX}${safe}/${seq}`;
}

/**
 * Commit the worktree to a hidden ref without moving HEAD.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {number} seq
 * @param {NodeJS.ProcessEnv} env
 */
export async function captureWorktreeCheckpoint(cwd, sessionId, seq, env) {
  const ref = checkpointRef(sessionId, seq);
  const gitDir = (await git(cwd, ["rev-parse", "--git-dir"], env)).trim();
  const tmpIndex = path.join(cwd, gitDir, `shiba-checkpoint-index-${seq}`);
  const gitEnv = {
    ...env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "shiba",
    GIT_AUTHOR_EMAIL: "shiba@shiba.local",
    GIT_COMMITTER_NAME: "shiba",
    GIT_COMMITTER_EMAIL: "shiba@shiba.local",
  };
  await git(cwd, ["read-tree", "HEAD"], gitEnv);
  await git(cwd, ["add", "-A"], gitEnv);
  const tree = (await git(cwd, ["write-tree"], gitEnv)).trim();
  const commit = (
    await git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", `shiba checkpoint ${seq}`], gitEnv)
  ).trim();
  await git(cwd, ["update-ref", ref, commit], gitEnv);
  return ref;
}

/**
 * @param {string} cwd
 * @param {string} fromRef
 * @param {string} toRef
 * @param {NodeJS.ProcessEnv} env
 */
export async function diffCheckpointRefs(cwd, fromRef, toRef, env) {
  for (const ref of [fromRef, toRef]) {
    if (!ref.startsWith(CHECKPOINT_PREFIX)) throw new Error(`Refused checkpoint ref ${ref}`);
  }
  return git(cwd, ["diff", "--no-color", fromRef, toRef], env);
}

function spawnChild(bin, args, cwd, env) {
  const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  return child;
}

/**
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
 */
function attachLines(child, onLine) {
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== "") onLine(line);
    }
  });
}

/**
 * JSON-RPC 2.0 over a child's stdin/stdout. Server requests (method + id)
 * are dispatched without blocking the reader, so an approval can wait while
 * later notifications still arrive.
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
 */
function attachJsonRpc(child) {
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  /** @type {Array<(msg: Record<string, unknown>) => void>} */
  const onNotification = [];
  /** @type {Array<(msg: Record<string, unknown>) => void>} */
  const onRequest = [];
  const failPending = (error) => {
    for (const slot of pending.values()) slot.reject(error);
    pending.clear();
  };
  attachLines(child, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object") return;
    const record = /** @type {Record<string, unknown>} */ (msg);
    if (typeof record.method === "string" && record.id !== undefined && record.id !== null) {
      for (const handler of onRequest) handler(record);
      return;
    }
    if (
      record.id !== undefined &&
      record.id !== null &&
      pending.has(/** @type {number} */ (record.id))
    ) {
      const slot = pending.get(/** @type {number} */ (record.id));
      pending.delete(/** @type {number} */ (record.id));
      if (record.error && typeof record.error === "object") {
        const message = /** @type {{ message?: string }} */ (record.error).message ?? "rpc error";
        slot?.reject(new Error(message));
      } else {
        slot?.resolve(record.result);
      }
      return;
    }
    if (typeof record.method === "string") {
      for (const handler of onNotification) handler(record);
    }
  });
  child.on("close", () => failPending(new Error("codex app-server closed")));
  child.on("error", (error) => failPending(error));
  const send = (msg) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params: params ?? {} });
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    respond(id, result) {
      send({ jsonrpc: "2.0", id, result });
    },
    respondError(id, message) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
    },
    onNotification(handler) {
      onNotification.push(handler);
    },
    onRequest(handler) {
      onRequest.push(handler);
    },
  };
}

function codexApproval(method, params) {
  const record =
    params && typeof params === "object" ? /** @type {Record<string, unknown>} */ (params) : {};
  const command = typeof record.command === "string" ? record.command : "";
  const reason = typeof record.reason === "string" ? record.reason : "";
  const fileChange = method.includes("file") || method.includes("Patch");
  const kind = fileChange
    ? "file_change"
    : method.includes("permission")
      ? "permission"
      : "command";
  const title = command || reason || method;
  return {
    requestId: String(record.approvalId || record.itemId || randomUUID()),
    kind,
    name: command ? "command" : method,
    title: bound(title, 200),
    detail: bound([command, reason, record.grantRoot].filter(Boolean).join("\n"), 2000),
  };
}

/**
 * @param {object} spec
 * @param {(event: SessionEvent) => void} emit
 */
async function openCodex(spec, emit) {
  const policy = codexPolicy(spec.permissionMode ?? "approval-required");
  const bin = spec.bin || "codex";
  const args = [...(spec.binArgs ?? []), "app-server", "--listen", "stdio://"];
  for (const entry of spec.launchArgs ?? []) args.push("-c", entry);
  const child = spawnChild(bin, args, spec.cwd, spec.env ?? process.env);
  spec.onChild?.(child);
  const rpc = attachJsonRpc(child);
  let threadId = spec.resumeThreadId ?? "";
  let turnId = "";
  /** @type {((outcome: { status: string, summary: string }) => void) | null} */
  let settle = null;
  let interrupted = false;
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    if (stderr.length > 20) stderr.shift();
  });

  const finish = (status, summary) => {
    if (!settle) return;
    const done = settle;
    settle = null;
    done({ status, summary: bound(summary, 4000) });
  };

  rpc.onNotification((msg) => {
    const params =
      msg.params && typeof msg.params === "object"
        ? /** @type {Record<string, unknown>} */ (msg.params)
        : {};
    if (msg.method === "thread/started") {
      const thread =
        params.thread && typeof params.thread === "object"
          ? /** @type {Record<string, unknown>} */ (params.thread)
          : {};
      if (typeof thread.id === "string") threadId = thread.id;
      emit({ type: "thread.updated", threadId, status: "ready" });
    } else if (msg.method === "turn/started") {
      const turn =
        params.turn && typeof params.turn === "object"
          ? /** @type {Record<string, unknown>} */ (params.turn)
          : {};
      if (typeof turn.id === "string") turnId = turn.id;
      if (typeof params.turnId === "string") turnId = params.turnId;
      emit({ type: "turn.started", turnId, threadId });
    } else if (msg.method === "item/agentMessage/delta") {
      const text = typeof params.delta === "string" ? params.delta : "";
      if (text) emit({ type: "message.delta", text, turnId, threadId });
    } else if (msg.method === "turn/diff/updated") {
      const patch = typeof params.diff === "string" ? params.diff : "";
      emit({ type: "diff.updated", patch, turnId, threadId, text: "diff updated" });
    } else if (msg.method === "item/started" || msg.method === "item/completed") {
      const item =
        params.item && typeof params.item === "object"
          ? /** @type {Record<string, unknown>} */ (params.item)
          : params;
      const name =
        typeof item.command === "string"
          ? item.command
          : typeof item.type === "string"
            ? item.type
            : "tool";
      emit({
        type: msg.method === "item/started" ? "tool.started" : "tool.completed",
        name: bound(name, 200),
        turnId,
        threadId,
      });
    } else if (msg.method === "turn/completed") {
      const turn =
        params.turn && typeof params.turn === "object"
          ? /** @type {Record<string, unknown>} */ (params.turn)
          : {};
      const status = typeof turn.status === "string" ? turn.status : "completed";
      if (status === "inProgress") return;
      const error = turn.error && typeof turn.error === "object" ? JSON.stringify(turn.error) : "";
      finish(interrupted ? "interrupted" : status === "failed" ? "failed" : status, error);
    } else if (msg.method === "error") {
      const message = typeof params.message === "string" ? params.message : "codex error";
      emit({ type: "error", message: bound(message, 500) });
      finish("failed", message);
    }
  });

  rpc.onRequest((msg) => {
    const method = String(msg.method);
    if (method === "account/chatgptAuthTokens/refresh") {
      rpc.respondError(msg.id, "refresh stays outside the sandbox");
      return;
    }
    if (method === "item/tool/call") {
      rpc.respondError(msg.id, "shiba does not execute item/tool/call callbacks");
      return;
    }
    const approvalMethods = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ];
    if (!approvalMethods.includes(method) && method !== "item/tool/requestUserInput") {
      rpc.respondError(msg.id, `unsupported server request ${method}`);
      return;
    }
    void (async () => {
      const request = codexApproval(method, msg.params);
      const decision = await resolveDecision(spec, emit, request);
      if (method === "item/tool/requestUserInput") {
        rpc.respond(msg.id, { answers: {} });
        return;
      }
      rpc.respond(msg.id, { decision: decision === "allow" ? "accept" : "decline" });
    })().catch((error) => {
      const message = error instanceof Error ? error.message : "approval failed";
      rpc.respond(msg.id, { decision: "decline" });
      finish("failed", message);
    });
  });

  await rpc.request("initialize", {
    clientInfo: { name: "shiba", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized");

  const threadParams = {
    cwd: spec.cwd,
    model: spec.model,
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.sandbox,
    approvalsReviewer: "user",
  };
  if (threadId) {
    const resumed = await rpc.request("thread/resume", { ...threadParams, threadId });
    const thread =
      resumed && typeof resumed === "object"
        ? /** @type {Record<string, unknown>} */ (resumed).thread
        : undefined;
    if (
      thread &&
      typeof thread === "object" &&
      typeof (/** @type {Record<string, unknown>} */ (thread).id) === "string"
    ) {
      threadId = /** @type {Record<string, string>} */ (thread).id;
    }
  } else {
    const started = await rpc.request("thread/start", threadParams);
    const thread =
      started && typeof started === "object"
        ? /** @type {Record<string, unknown>} */ (started).thread
        : undefined;
    if (
      !thread ||
      typeof thread !== "object" ||
      typeof (/** @type {Record<string, unknown>} */ (thread).id) !== "string"
    ) {
      throw new Error("codex thread/start did not return a thread id");
    }
    threadId = /** @type {Record<string, string>} */ (thread).id;
  }
  emit({ type: "thread.updated", threadId, status: "ready" });

  return {
    get threadId() {
      return threadId;
    },
    startTurn(prompt) {
      interrupted = false;
      const pending = new Promise((resolve) => {
        settle = resolve;
      });
      return rpc
        .request("turn/start", {
          threadId,
          cwd: spec.cwd,
          model: spec.model,
          approvalPolicy: policy.approvalPolicy,
          sandboxPolicy: policy.sandboxPolicy,
          approvalsReviewer: "user",
          input: [{ type: "text", text: prompt }],
        })
        .then((result) => {
          const turn =
            result && typeof result === "object"
              ? /** @type {Record<string, unknown>} */ (result).turn
              : undefined;
          if (turn && typeof turn === "object") {
            const record = /** @type {Record<string, unknown>} */ (turn);
            if (typeof record.id === "string") turnId = record.id;
            emit({ type: "turn.started", turnId, threadId });
            if (typeof record.status === "string" && record.status !== "inProgress") {
              finish(record.status, "");
            }
          }
          return pending;
        });
    },
    async interrupt() {
      interrupted = true;
      if (!turnId) return;
      await rpc.request("turn/interrupt", { threadId, turnId });
    },
    async resume(nextThreadId) {
      threadId = nextThreadId;
      await rpc.request("thread/resume", { ...threadParams, threadId: nextThreadId });
      emit({ type: "thread.updated", threadId, status: "ready" });
    },
    close() {
      finish("failed", "session closed");
      child.kill("SIGTERM");
    },
  };
}

/**
 * @param {object} spec
 * @param {(event: SessionEvent) => void} emit
 * @param {{ requestId: string, kind: string, name?: string, title: string, detail: string }} request
 */
async function resolveDecision(spec, emit, request) {
  const mode = spec.permissionMode ?? "approval-required";
  emit({
    type: "approval.requested",
    requestId: request.requestId,
    kind: request.kind,
    title: request.title,
    detail: request.detail,
  });
  const automatic = autoDecision(mode, request);
  const decision = automatic ?? (await spec.onApproval?.(request)) ?? "deny";
  const normalized = decision === "allow" ? "allow" : "deny";
  emit({ type: "approval.resolved", requestId: request.requestId, decision: normalized });
  return normalized;
}

/**
 * @param {object} spec
 * @param {(event: SessionEvent) => void} emit
 */
async function openClaude(spec, emit) {
  const bin = spec.bin || "claude";
  const args = [
    ...(spec.binArgs ?? []),
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    claudePermissionMode(spec.permissionMode ?? "approval-required"),
    "--model",
    spec.model || "claude",
    "--add-dir",
    spec.cwd,
  ];
  if (spec.resumeThreadId) args.push("--resume", spec.resumeThreadId);
  const child = spawnChild(bin, args, spec.cwd, spec.env ?? process.env);
  spec.onChild?.(child);
  let threadId = spec.resumeThreadId ?? "";
  let prompted = false;
  let promptText = "";
  /** @type {((outcome: { status: string, summary: string }) => void) | null} */
  let settle = null;
  let interrupted = false;
  /** @type {string[]} */
  const assistant = [];

  const send = (msg) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const finish = (status, summary) => {
    if (!settle) return;
    const done = settle;
    settle = null;
    done({ status, summary: bound(summary, 4000) });
  };
  const sendPrompt = () => {
    if (prompted || promptText === "") return;
    prompted = true;
    send({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: promptText }] },
    });
  };

  attachLines(child, (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object") return;
    const record = /** @type {Record<string, unknown>} */ (msg);
    if (record.type === "system" && record.subtype === "init") {
      if (typeof record.session_id === "string") threadId = record.session_id;
      emit({ type: "thread.updated", threadId, status: "ready" });
      sendPrompt();
      return;
    }
    if (record.type === "control_request") {
      const request =
        record.request && typeof record.request === "object"
          ? /** @type {Record<string, unknown>} */ (record.request)
          : {};
      if (request.subtype !== "can_use_tool") return;
      const input =
        request.input && typeof request.input === "object"
          ? /** @type {Record<string, unknown>} */ (request.input)
          : {};
      const command = typeof input.command === "string" ? input.command : "";
      const name = typeof request.tool_name === "string" ? request.tool_name : "tool";
      const requestId = String(record.request_id ?? randomUUID());
      const readOnly = name === "Read" || name === "Grep" || name === "Glob";
      void resolveDecision(spec, emit, {
        requestId,
        kind: readOnly
          ? "permission"
          : name === "Edit" || name === "Write" || name === "NotebookEdit"
            ? "file_change"
            : "command",
        name,
        title: bound(command || name, 200),
        detail: bound(command || JSON.stringify(input), 2000),
      })
        .then((decision) => {
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: record.request_id,
              response:
                decision === "allow"
                  ? { behavior: "allow", updatedInput: input }
                  : { behavior: "deny", message: "denied by shiba" },
            },
          });
        })
        .catch((error) => {
          send({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: record.request_id,
              response: { behavior: "deny", message: "approval failed" },
            },
          });
          finish("failed", error instanceof Error ? error.message : "approval failed");
        });
      return;
    }
    if (record.type === "stream_event") {
      const event =
        record.event && typeof record.event === "object"
          ? /** @type {Record<string, unknown>} */ (record.event)
          : {};
      const delta =
        event.delta && typeof event.delta === "object"
          ? /** @type {Record<string, unknown>} */ (event.delta)
          : {};
      if (typeof delta.text === "string" && delta.text) {
        emit({ type: "message.delta", text: delta.text, threadId });
      }
      return;
    }
    if (record.type === "assistant") {
      const message =
        record.message && typeof record.message === "object"
          ? /** @type {Record<string, unknown>} */ (record.message)
          : {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const entry = /** @type {Record<string, unknown>} */ (block);
        if (typeof entry.text === "string" && entry.text) {
          assistant.push(entry.text);
          emit({ type: "message.completed", text: bound(entry.text, 4000), threadId });
        } else if (typeof entry.name === "string") {
          emit({
            type: entry.type === "tool_result" ? "tool.completed" : "tool.started",
            name: entry.name,
            threadId,
          });
        }
      }
      return;
    }
    if (record.type === "result") {
      const summary = typeof record.result === "string" ? record.result : assistant.join("");
      const failed = record.is_error === true || record.subtype === "error";
      finish(interrupted ? "interrupted" : failed ? "failed" : "completed", summary);
    }
  });
  child.on("close", () => {
    finish(interrupted ? "interrupted" : "failed", "claude closed before a result");
  });

  if (!threadId) emit({ type: "thread.updated", threadId: "", status: "starting" });

  return {
    get threadId() {
      return threadId;
    },
    startTurn(prompt) {
      interrupted = false;
      promptText = prompt;
      prompted = false;
      const pending = new Promise((resolve) => {
        settle = resolve;
      });
      emit({ type: "turn.started", threadId, turnId: "" });
      // If init already arrived, send now; otherwise init's handler sends.
      sendPrompt();
      if (!prompted) {
        setTimeout(sendPrompt, 200);
      }
      return pending;
    },
    async interrupt() {
      interrupted = true;
      send({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      });
    },
    async resume(nextThreadId) {
      threadId = nextThreadId;
      emit({ type: "thread.updated", threadId, status: "ready" });
    },
    close() {
      finish("failed", "session closed");
      child.kill("SIGTERM");
    },
  };
}

/**
 * @param {object} spec
 */
async function openProvider(spec, emit) {
  if (spec.provider === "codex") return openCodex(spec, emit);
  if (spec.provider === "claude") return openClaude(spec, emit);
  throw new Error(`Unknown session provider ${spec.provider}`);
}

/**
 * One session: its own child process, event log, and checkpoint refs.
 * @param {object} spec
 */
async function openLoggedSession(spec) {
  const id = spec.id || randomUUID();
  // Never the worktree: `git add -A` would otherwise record the JSONL as a change.
  const logDir = spec.logDir || path.join(os.tmpdir(), "shiba-sessions");
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
  /** @type {Array<{ seq: number, at: number, event: SessionEvent }>} */
  const records = [];
  let seq = 0;
  /** @type {string[]} */
  const refs = [];
  let writeChain = Promise.resolve();
  const emit = (event) => {
    const record = { seq: ++seq, at: Date.now(), event };
    records.push(record);
    writeChain = writeChain
      .then(() => fs.appendFile(logPath, `${JSON.stringify(record)}\n`))
      .catch(() => undefined);
    spec.onEvent?.(event);
  };
  emit({ type: "session.updated", sessionId: id, status: "starting" });
  const provider = await openProvider(spec, emit);
  emit({ type: "session.updated", sessionId: id, status: "ready", threadId: provider.threadId });
  const env = spec.env ?? process.env;
  return {
    id,
    logPath,
    get threadId() {
      return provider.threadId;
    },
    get events() {
      return records.map((record) => record.event);
    },
    get records() {
      return records;
    },
    async turn(prompt) {
      emit({ type: "session.updated", sessionId: id, status: "running" });
      const outcome = await provider.startTurn(prompt);
      emit({
        type: "turn.completed",
        status: outcome.status,
        summary: outcome.summary,
        threadId: provider.threadId,
      });
      emit({ type: "session.updated", sessionId: id, status: "ready" });
      return outcome;
    },
    interrupt() {
      return provider.interrupt();
    },
    async resume(threadId) {
      await provider.resume(threadId);
      emit({ type: "thread.updated", threadId, status: "ready" });
    },
    async checkpoint() {
      const ref = await captureWorktreeCheckpoint(spec.cwd, id, refs.length, env);
      refs.push(ref);
      emit({ type: "checkpoint.captured", ref });
      return ref;
    },
    async diff() {
      if (refs.length < 2) return "";
      const patch = await diffCheckpointRefs(spec.cwd, refs[0], refs[refs.length - 1], env);
      emit({ type: "diff.updated", patch, text: "diff updated" });
      return patch;
    },
    async close() {
      provider.close();
      await writeChain;
      emit({ type: "session.updated", sessionId: id, status: "stopped" });
      await writeChain;
    },
  };
}

/** Several sessions at once — each has its own CLI process and JSONL log. */
export function createSessionManager() {
  /** @type {Map<string, Awaited<ReturnType<typeof openLoggedSession>>>} */
  const sessions = new Map();
  return {
    async open(spec) {
      const session = await openLoggedSession(spec);
      sessions.set(session.id, session);
      return session;
    },
    list() {
      return [...sessions.keys()];
    },
    get(id) {
      return sessions.get(id) ?? null;
    },
    async closeAll() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((session) => session.close()));
    },
  };
}

/**
 * Read a session JSONL log back in sequence order.
 * @param {string} logPath
 */
export async function readEventLog(logPath) {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Run one turn: optional resume, checkpoint, provider turn, checkpoint, diff.
 * @param {object} job
 */
export async function runSessionJob(job) {
  const manager = createSessionManager();
  /** @type {SessionEvent[]} */
  const events = [];
  const emitStdout = job.emitStdout ?? job.onEvent === undefined;
  /** @type {Awaited<ReturnType<typeof manager.open>> | null} */
  let session = null;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  try {
    session = await manager.open({
      ...job,
      onEvent(event) {
        events.push(event);
        if (emitStdout) {
          process.stdout.write(
            `${JSON.stringify({ type: "shiba.event", event, text: eventText(event) })}\n`,
          );
        }
        job.onEvent?.(event);
      },
    });
    if (job.control !== undefined) {
      const current = session;
      timer = setInterval(() => {
        Promise.resolve()
          .then(() => job.control())
          .then((control) => {
            if (control?.interrupt) return current.interrupt();
            return undefined;
          })
          .catch(() => undefined);
      }, job.controlIntervalMs ?? 400);
      timer.unref?.();
    }
    // resumeThreadId is applied when the provider process starts.
    if (job.checkpoints !== false) await session.checkpoint();
    const outcome = await session.turn(job.prompt);
    let diff = "";
    if (job.checkpoints !== false) {
      await session.checkpoint();
      diff = await session.diff();
    }
    const providerDiff = [...events]
      .reverse()
      .find((event) => event.type === "diff.updated" && event.patch);
    return {
      exitCode: outcome.status === "completed" ? 0 : 1,
      status: outcome.status,
      summary: outcome.summary || eventText({ type: "turn.completed", status: outcome.status }),
      threadId: session.threadId,
      diff: diff || providerDiff?.patch || "",
      events,
      logPath: session.logPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      status: "failed",
      summary: message,
      threadId: session?.threadId ?? "",
      diff: "",
      events,
      logPath: session?.logPath ?? "",
    };
  } finally {
    if (timer) clearInterval(timer);
    if (session) await session.close();
  }
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) {
    process.stderr.write("shiba-session: pass a job json path\n");
    process.exit(2);
  }
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  const result = await runSessionJob({ ...job, emitStdout: true });
  process.stdout.write(
    `${JSON.stringify({ type: "shiba.result", result: { ...result, events: undefined } })}\n`,
  );
  process.exit(result.exitCode);
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
