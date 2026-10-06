/**
 * `shiba-acp` — the ACP (Agent Client Protocol) server face of a Shiba
 * deployment. The editor talks ACP over stdio; this process talks the
 * deployment's operator HTTP surface:
 *
 *   session/new      → remember cwd + infer the repo remote
 *   session/prompt   → POST /api/runs (mints an approval) →
 *                      session/request_permission (the human gate in-editor)
 *                      → POST /api/approvals → poll /api/spine + /api/runs
 *                      → stream run.progress as agent_message_chunk
 *                      → {stopReason:"end_turn"} on a terminal status
 *   session/cancel   → DELETE /api/runs/<runId>
 *   session/set_model→ carried into the run's codingModel
 *
 * Shiba's own approval-gate is the star of the mapping: nothing runs until
 * the human in the editor picks "Approve" — the same gate the dashboard,
 * Slack, and email lanes answer.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SpineEvent } from "@shiba/shared";
import type { ShibaClient } from "./client.js";
import { JsonRpcPeer, type JsonRpcInbound } from "./jsonrpc.js";

const THREAD_KEY_PREFIX = "acp";
const SPINE_POLL_MS = 1500;
const RUNS_POLL_LIMIT = 50;
const TERMINAL_STATUSES = new Set(["completed", "error", "aborted", "cancelled"]);

interface SessionState {
  id: string;
  cwd: string;
  repoUrl: string | null;
  baseBranch: string;
  model: string | null;
  runId: string | null;
  spineCursor: number;
  cancelled: boolean;
  /** Resolves when the current prompt's run reaches a terminal state. */
  settle: { resolve: (stopReason: string) => void } | null;
}

export interface ServerDeps {
  client: ShibaClient;
  peer: JsonRpcPeer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  execGitRemote?: (cwd: string) => string | null;
  version?: string;
}

function defaultGitRemote(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** git@ / ssh:// / https:// remotes → the https URL queueRun validates. */
export function normalizeRepoUrl(remote: string): string | null {
  const ssh = remote.match(/^(?:ssh:\/\/git@|git@)([^:/]+)[:/]([^/]+\/.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (remote.startsWith("https://") || remote.startsWith("http://")) return remote.replace(/\.git$/, "");
  return null;
}

export class ShibaAcpServer {
  private readonly sessions = new Map<string, SessionState>();
  private initialized = false;

  constructor(private readonly deps: ServerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep !== undefined ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  async handle(msg: JsonRpcInbound): Promise<void> {
    if (msg.kind === "response") {
      this.deps.peer.handleResponse(msg);
      return;
    }
    if (msg.kind === "notification") {
      if (msg.method === "session/cancel") {
        await this.onCancel(msg.params);
      }
      return;
    }
    // Request — route; unknown methods answer -32601 like every ACP peer.
    try {
      const result = await this.onRequest(msg.method, msg.params);
      this.deps.peer.respond(msg.id, result ?? {});
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.peer.respondError(msg.id, detail.startsWith("METHOD_NOT_FOUND:") ? -32601 : -32603, detail.replace(/^METHOD_NOT_FOUND:/, ""));
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.onInitialize(params);
      case "authenticate":
        // Token env is the whole credential story — nothing to exchange.
        return {};
      case "session/new":
        return this.onSessionNew(params);
      case "session/prompt":
        return await this.onPrompt(params);
      case "session/set_model":
        return this.onSetModel(params);
      case "session/set_mode":
        // Shiba has one mode: approval-gated. Accept quietly.
        return {};
      default:
        throw new Error(`METHOD_NOT_FOUND:client does not implement ${method}`);
    }
  }

  private onInitialize(_params: unknown): Record<string, unknown> {
    this.initialized = true;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { text: true, image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: "shiba-acp", version: this.deps.version ?? "0.1.0" },
      authMethods: [],
    };
  }

  private onSessionNew(params: unknown): Record<string, unknown> {
    if (!this.initialized) throw new Error("initialize must come first");
    const p = (params ?? {}) as { cwd?: string; mcpServers?: unknown[] };
    const cwd = typeof p.cwd === "string" && p.cwd !== "" ? p.cwd : process.cwd();
    const gitRemote = this.deps.execGitRemote ?? defaultGitRemote;
    const repoUrl = normalizeRepoUrl(gitRemote(cwd) ?? "");
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      cwd,
      repoUrl,
      baseBranch: "main",
      model: null,
      runId: null,
      spineCursor: 0,
      cancelled: false,
      settle: null,
    });
    return { sessionId: id };
  }

  private onSetModel(params: unknown): Record<string, unknown> {
    const p = (params ?? {}) as { sessionId?: string; modelId?: string };
    const session = this.sessionFor(p.sessionId);
    session.model = typeof p.modelId === "string" && p.modelId !== "" ? p.modelId : null;
    return {};
  }

  private sessionFor(sessionId: string | undefined): SessionState {
    const session = sessionId !== undefined ? this.sessions.get(sessionId) : undefined;
    if (session === undefined) throw new Error(`Unknown sessionId ${JSON.stringify(sessionId ?? null)}`);
    return session;
  }

  private emitUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.deps.peer.notify("session/update", { sessionId, update });
  }

  private async requestPermission(args: {
    sessionId: string;
    toolCallId: string;
    title: string;
    kind: string;
  }): Promise<"allow" | "reject"> {
    const res = (await this.deps.peer.request("session/request_permission", {
      sessionId: args.sessionId,
      toolCall: {
        toolCallId: args.toolCallId,
        title: args.title,
        kind: args.kind,
        status: "pending",
        rawInput: {},
      },
      options: [
        { optionId: "approve", name: "Approve run", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    })) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
    const outcome = res?.outcome;
    return outcome?.outcome === "selected" && outcome.optionId === "approve" ? "allow" : "reject";
  }

  private async onCancel(params: unknown): Promise<void> {
    const p = (params ?? {}) as { sessionId?: string };
    const session = p.sessionId === undefined ? undefined : this.sessions.get(p.sessionId);
    if (session === undefined) return;
    session.cancelled = true;
    if (session.runId !== null) {
      try {
        await this.deps.client.cancelRun(session.runId);
      } catch {
        // A cancel racing a terminal status is fine — the poll loop settles it.
      }
    }
    session.settle?.resolve("cancelled");
    session.settle = null;
  }

  /**
   * Where the frozen-input approval lands the run: resolveApproval mints
   * it, then /api/runs shows a record whose approval evidence names our
   * approvalId.
   */
  private async findRunId(approvalId: string): Promise<string | null> {
    const { runs } = await this.deps.client.listRuns(RUNS_POLL_LIMIT);
    const mine = runs.find((r) => r.approval?.approvalId === approvalId);
    return mine?.runId ?? null;
  }

  private async onPrompt(params: unknown): Promise<Record<string, unknown>> {
    const p = (params ?? {}) as { sessionId?: string; prompt?: Array<{ type?: string; text?: string }> };
    const session = this.sessionFor(p.sessionId);
    const text = (p.prompt ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (text === "") return { stopReason: "end_turn" };
    if (session.repoUrl === null) {
      this.emitUpdate(session.id, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `No git remote under ${session.cwd} — the run needs a repository URL.` },
      });
      return { stopReason: "end_turn" };
    }

    // 1. Mint the approval — nothing runs yet; the gate IS the product.
    const queued = await this.deps.client.queueRun({
      repoUrl: session.repoUrl,
      task: text,
      baseBranch: session.baseBranch,
      ...(session.model !== null ? { codingModel: session.model } : {}),
      commandId: `acp:${session.id}:${this.now()}`,
    });
    this.emitUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `Run queued on ${session.repoUrl} — approval ${queued.approvalId} needs your decision.`,
      },
    });

    // 2. The gate, in-editor: Shiba's approval card as an ACP permission.
    const pick = await this.requestPermission({
      sessionId: session.id,
      toolCallId: queued.approvalId,
      title: `Approve run: ${text.slice(0, 120)}`,
      kind: "execute",
    });
    const decision = await this.deps.client.resolveApproval({
      threadKey: `${THREAD_KEY_PREFIX}:${session.id}`,
      approvalId: queued.approvalId,
      approved: pick === "allow",
      decidedBy: "acp-client",
    });
    if (pick === "reject" || decision.result === "rejected") {
      return { stopReason: "refusal" };
    }

    // 3. Follow the run: spine events → session/update; run record → terminal.
    const settled = new Promise<string>((resolve) => {
      session.settle = { resolve };
    });
    void this.pump(session, queued.approvalId);
    const stopReason = await settled;
    return { stopReason };
  }

  private async pump(session: SessionState, approvalId: string): Promise<void> {
    let runId = session.runId;
    let settledBy: string | null = null;
    while (!session.cancelled) {
      // Spine events → session/update (incremental, cursor-paged).
      try {
        const page = await this.deps.client.fetchSpine(session.spineCursor);
        for (const event of page.events) {
          session.spineCursor = Math.max(session.spineCursor, event.seq);
          this.emitSpineEvent(session, event);
        }
      } catch {
        // A dropped poll just delays updates; the run record check below still settles.
      }

      if (runId === null) {
        try {
          runId = await this.findRunId(approvalId);
          if (runId !== null) session.runId = runId;
        } catch {
          // keep polling
        }
      } else {
        try {
          const run = await this.deps.client.getRun(runId);
          if (TERMINAL_STATUSES.has(run.status)) {
            if (typeof run.summary === "string" && run.summary !== "") {
              this.emitUpdate(session.id, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: run.summary },
              });
            }
            if (typeof run.pullUrl === "string" && run.pullUrl !== "") {
              this.emitUpdate(session.id, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `Pull request: ${run.pullUrl}` },
              });
            }
            settledBy = run.status === "cancelled" ? "cancelled" : "end_turn";
            session.settle?.resolve(settledBy);
            session.settle = null;
            return;
          }
        } catch {
          // transient — poll again
        }
      }
      await this.sleep(SPINE_POLL_MS);
    }
    if (settledBy === null) {
      session.settle?.resolve(session.cancelled ? "cancelled" : "end_turn");
      session.settle = null;
    }
  }

  /** Spine → ACP update mapping: progress text chunks + side-effect tool calls. */
  private emitSpineEvent(session: SessionState, event: SpineEvent): void {
    if (session.runId !== null && event.runId !== undefined && event.runId !== session.runId) return;
    const text = (prefix: string, detail?: unknown) =>
      this.emitUpdate(session.id, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: detail === undefined ? prefix : `${prefix}${String(detail)}` },
      });
    const payload = event.payload;
    switch (event.kind) {
      case "run.progress":
        if (payload !== undefined && "summary" in payload && typeof payload.summary === "string") {
          text(payload.summary);
        }
        break;
      case "run.started":
        text(`Run ${event.runId ?? ""} started.`);
        break;
      case "run.completed":
        text(`Run ${event.runId ?? ""} completed.`);
        break;
      case "run.failed":
        text(`Run ${event.runId ?? ""} failed${payload !== undefined && "error" in payload && payload.error !== undefined ? `: ${String(payload.error)}` : "."}`);
        break;
      case "run.cancelled":
        text(`Run ${event.runId ?? ""} cancelled.`);
        break;
      case "side_effect.dispatched":
      case "side_effect.failed":
        if (payload !== undefined && "effectId" in payload) {
          this.emitUpdate(session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId: payload.effectId,
            status: event.kind === "side_effect.dispatched" ? "completed" : "failed",
            title: "summary" in payload && payload.summary !== undefined ? payload.summary : payload.effectKind,
          });
        }
        break;
      default:
        break;
    }
  }
}
