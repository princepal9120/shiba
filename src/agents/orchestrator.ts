/**
 * Planning and delegation agent. It never edits repositories itself:
 * the only repository-touching capability is delegate_coding_task, which
 * requires explicit human approval and runs inside an isolated Sandbox
 * container driven by OpenCodeAgent.
 */
import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env.js";
import {
  formatAgentToolInput,
  parseAgentResult,
  type CodingTaskInput,
} from "../opencode-input.js";
import {
  MAX_CONCURRENT_RUNS,
  RunStore,
  canStartRun,
  createRun,
  isActiveStatus,
  reclaimStaleRuns,
  recordReceipt,
  type DelegatedRun,
  type RunStatus,
} from "../runs.js";
import { makeReceipt } from "../receipts.js";
import {
  createPendingApproval,
  pruneExpiredApprovals,
  resolvePendingApproval,
  type PendingApproval,
  type ResolveResult,
} from "../pending-approvals.js";
import { makeSandboxId, parseGitHubRepoUrl, redactSecrets } from "../security.js";
import { parseSlackThreadName } from "../slack-thread.js";
import { evaluateResultQuality } from "../result-quality.js";
import { HARNESS_DEFAULT_MODELS, allowedHostsFor, resolveHarness } from "../harness/index.js";
import { OpenCodeAgent } from "./opencode-agent.js";

export interface OrchestratorState {
  runs: DelegatedRun[];
  pendingApprovals?: PendingApproval[];
}

const delegateInputSchema = z.object({
  repoUrl: z.string().describe("HTTPS GitHub repository URL, e.g. https://github.com/owner/repo."),
  task: z.string().describe("The coding task to perform in the repository."),
  baseBranch: z
    .string()
    .optional()
    .default("main")
    .describe("Base branch to clone. Defaults to main."),
  publishPullRequest: z
    .boolean()
    .optional()
    .default(false)
    .describe("Open a pull request with the result. Requires GITHUB_TOKEN."),
  harness: z
    .enum(["opencode", "claude-code", "codex", "devin"])
    .optional()
    .describe(
      "Coding agent harness. Defaults to the deployment's AGENT_HARNESS, else opencode. " +
        "claude-code needs an anthropic/* model; codex needs an openai/* model; devin needs a devin/* model.",
    ),
  codingModel: z
    .string()
    .optional()
    .describe(
      "Coding model as provider/model, e.g. google/gemini-3.5-flash-lite. " +
        "Defaults to the deployment's per-harness model.",
    ),
});

type DelegateInput = z.infer<typeof delegateInputSchema>;

const DEFAULT_ORCHESTRATOR_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export class CodingOrchestrator extends Think<Env, OrchestratorState> {
  /** The orchestrator plans and delegates; it never runs shell commands. */
  override workspaceBash = false;

  // Abort signal per active run so cancel/reclaim reaches the child container,
  // not just the registry row. Lazy: DO subclasses may be constructed without
  // the base constructor in tests.
  private runControllersMap: Map<string, AbortController> | undefined;
  private get runControllers(): Map<string, AbortController> {
    return (this.runControllersMap ??= new Map());
  }

  private get store(): RunStore {
    return new RunStore(
      () => this.state?.runs ?? [],
      (runs) => this.setState({ ...this.state, runs }),
    );
  }

  private get approvals(): PendingApproval[] {
    return this.state?.pendingApprovals ?? [];
  }

  private writeApprovals(next: PendingApproval[]): void {
    this.setState({ ...this.state, pendingApprovals: next });
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    const interrupted = this.approvals
      .filter((approval) => approval.status === "approved")
      .map((approval) => this.store.get(`agent-tool:${approval.approvalId}`))
      .filter((run): run is DelegatedRun => run !== null && isActiveStatus(run.status));
    // Do not retry potentially published work after losing the execution context.
    for (const run of interrupted) {
      this.store.transition(run.runId, "unknown", {
        error: "Execution interrupted by orchestrator restart. Inspect repository state before retrying.",
        errorCode: "outcome_unknown",
      });
    }
    await Promise.all(interrupted.map((run) => this.destroySandbox(run.sandboxId)));
  }

  override getModel(): string {
    return this.env.ORCHESTRATOR_MODEL || DEFAULT_ORCHESTRATOR_MODEL;
  }

  override getSystemPrompt(): string {
    return [
      "You are AI Intern, a planning and delegation agent.",
      "You never edit repositories yourself. When the user describes a coding task,",
      "call delegate_coding_task with the repository URL and the task.",
      "Pass the harness the user asked for (opencode, claude-code, codex, or devin) when they name one,",
      "and a codingModel as provider/model when they name a model; otherwise leave both unset.",
      "The tool requires human approval before anything runs: summarize exactly",
      "what will happen (repository, branch, task, whether a pull request is requested).",
      "After the run finishes, report the summary, changed files, and diff to the user.",
      "If the run fails, report the failure honestly with the exit code and error.",
    ].join(" ");
  }

  override getTools(): ToolSet {
    const child = agentTool(OpenCodeAgent, {
      description:
        "Delegate a coding task to an isolated Cloudflare Sandbox container running OpenCode. " +
        "The container clones the repository, runs the task headlessly, and returns changed files plus a unified diff.",
      inputSchema: delegateInputSchema,
      displayName: "Sandbox coding run",
    });
    const childExecute = child.execute;
    if (typeof childExecute !== "function") {
      throw new Error("delegate_coding_task misconfigured: child tool has no execute function.");
    }
    const delegate = tool({
      description:
        "Delegate a coding task to an isolated Cloudflare Sandbox container running OpenCode. " +
        "Requires human approval before anything runs.",
      inputSchema: delegateInputSchema,
      needsApproval: true,
      execute: async (input: DelegateInput, options?: { toolCallId?: string; abortSignal?: AbortSignal }) => {
        return this.executeDelegatedTask(input, childExecute, options?.toolCallId, options?.abortSignal);
      },
    });
    return { ...super.getTools(), delegate_coding_task: delegate };
  }

  private resolveHarnessAndModel(input: DelegateInput): { harness: string; codingModel: string } {
    const harnessName = input.harness ?? this.env.AGENT_HARNESS?.trim() ?? "opencode";
    const harness = resolveHarness(harnessName);
    const perHarnessVar =
      harness.name === "opencode"
        ? this.env.CODING_MODEL?.trim()
        : harness.name === "claude-code"
          ? this.env.CLAUDE_CODE_MODEL?.trim()
          : harness.name === "codex"
            ? this.env.CODEX_MODEL?.trim()
            : this.env.DEVIN_MODEL?.trim();
    const codingModel =
      input.codingModel?.trim() ||
      perHarnessVar ||
      (HARNESS_DEFAULT_MODELS[harness.name] as string);
    // Throws on an unsupported provider for this harness (T23) — here, at
    // approval time, so the failure surfaces before a container starts.
    allowedHostsFor(harness, codingModel);
    return { harness: harness.name, codingModel };
  }

  private async executeDelegatedTask(
    input: DelegateInput,
    childExecute: NonNullable<ReturnType<typeof agentTool>["execute"]>,
    toolCallId: string | undefined,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    abortSignal?.throwIfAborted();
    await this.reclaimRuns();
    abortSignal?.throwIfAborted();
    const runs = this.store.list();
    const callId = toolCallId ?? crypto.randomUUID();
    const runId = `agent-tool:${callId}`;
    const reserved = this.store.get(runId);
    if (!reserved && this.approvals.some((approval) => approval.approvalId === callId && approval.status === "approved")) {
      return "Run was removed before execution.";
    }
    if (reserved && reserved.status !== "pending") {
      return reserved.summary ?? reserved.error ?? `Run is ${reserved.status}.`;
    }
    if (!reserved && !canStartRun(runs)) {
      throw new Error(
        `Already running ${MAX_CONCURRENT_RUNS} coding tasks. Wait for one to finish before starting another.`,
      );
    }
    parseGitHubRepoUrl(input.repoUrl);
    if (input.publishPullRequest && !this.env.GITHUB_TOKEN) {
      throw new Error(
        "publishPullRequest was requested but GITHUB_TOKEN is not configured. " +
          "Set the GITHUB_TOKEN secret or retry without requesting a pull request.",
      );
    }
    // Resolve harness + model HERE, at approval time: the human approves the
    // exact harness and model that will execute, and an unsupported
    // harness/model pair fails before a container starts — not inside one.
    const { harness: resolvedHarness, codingModel } = this.resolveHarnessAndModel(input);
    const sandboxId = makeSandboxId(input.repoUrl, input.task, callId);
    const fullInput: CodingTaskInput = {
      repoUrl: input.repoUrl,
      task: input.task,
      baseBranch: input.baseBranch,
      publishPullRequest: input.publishPullRequest,
      sandboxId,
      codingModel,
      harness: resolvedHarness as CodingTaskInput["harness"],
    };
    if (!reserved) this.store.add(
      createRun({
        runId,
        sandboxId,
        repoUrl: fullInput.repoUrl,
        task: fullInput.task,
        baseBranch: fullInput.baseBranch,
        publishPullRequest: fullInput.publishPullRequest,
      }),
    );
    const finish = (status: RunStatus, patch?: { summary?: string; error?: string; diff?: string }) => {
      this.store.transition(runId, status, patch);
      // Slack-originated runs get the outcome back in the thread; the
      // summary carries the PR link when one was published.
      if (status === "completed") {
        this.postToSlackThread(`Run completed for ${fullInput.repoUrl}\n${patch?.summary?.slice(0, 1500) ?? ""}`.trim());
      } else if (status === "error") {
        this.postToSlackThread(`Run failed for ${fullInput.repoUrl}\n${patch?.error?.slice(0, 1000) ?? ""}`.trim());
      }
    };
    this.store.transition(runId, "running");
    this.postToSlackThread(`Run started for ${fullInput.repoUrl} (${fullInput.baseBranch ?? "main"}).`);
    const controller = new AbortController();
    this.runControllers.set(runId, controller);
    const signal = abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      const output = await childExecute(formatAgentToolInput(fullInput), { toolCallId: callId, abortSignal: signal });
      if (typeof output === "string") {
        // The child reports status in a structured envelope. Trusting the transport
        // type instead would mark failed runs "completed".
        const parsed = parseAgentResult(output);
        if (parsed?.status === "completed") {
          finish("completed", { summary: output.slice(0, 4000), diff: parsed?.diff ? parsed.diff.slice(0, 20000) : undefined });
          // TypeSafe Score: grade the run quality (fail-open — never blocks completion).
          // Terminal runs are immutable (transitionRun refuses them), so the
          // grade lands as a "grade" receipt on the finished record — never
          // as a second transition, which would be silently discarded.
          const tsKey = this.env.TYPESAFE_API_KEY?.trim() ?? "";
          if (tsKey) {
            evaluateResultQuality(tsKey, output.slice(0, 2000)).then((quality) => {
              if (!quality) return;
              const run = this.store.get(runId);
              if (run) {
                this.store.replace(
                  runId,
                  recordReceipt(run, makeReceipt("grade", `Result quality: ${quality.level} (score ${quality.score.toFixed(2)}, confidence ${quality.confidence.toFixed(2)}).`)),
                );
              }
            }).catch(() => { /* fail-open */ });
          }
          return output;
        }
        finish("error", {
          summary: output.slice(0, 4000),
          error: redactSecrets(parsed?.summary ?? output.slice(0, 4000)).slice(0, 4000),
        });
        return output;
      }
      const message = `Coding run failed: ${JSON.stringify(output).slice(0, 2000)}`;
      finish("error", { error: redactSecrets(message) });
      throw new Error(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish("error", { error: redactSecrets(message).slice(0, 4000) });
      throw error;
    } finally {
      this.runControllers.delete(runId);
      await this.destroySandbox(sandboxId);
    }
  }

  /**
   * Queue a Slack-initiated task as a pending approval: the exact delegation
   * input is frozen at queue time and nothing executes until a human
   * resolves the pointer via POST /api/approvals.
   */
  private queueSlackRun(input: { repoUrl?: unknown; task?: unknown; baseBranch?: unknown; publishPullRequest?: unknown; threadKey?: unknown }): Response {
    const repoUrl = typeof input.repoUrl === "string" ? input.repoUrl : "";
    const task = typeof input.task === "string" ? input.task : "";
    try {
      parseGitHubRepoUrl(repoUrl);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid repository URL." }, { status: 400 });
    }
    if (!task.trim()) {
      return Response.json({ error: "Task description is required." }, { status: 400 });
    }
    const publishPullRequest = input.publishPullRequest === true;
    if (publishPullRequest && !this.env.GITHUB_TOKEN) {
      return Response.json({ error: "publishPullRequest was requested but GITHUB_TOKEN is not configured." }, { status: 400 });
    }
    const approvalId = crypto.randomUUID();
    const threadKey = typeof input.threadKey === "string" && input.threadKey.trim() ? input.threadKey.trim() : "default";
    try {
      this.writeApprovals(createPendingApproval(this.approvals, {
        threadKey,
        approvalId,
        repoUrl,
        task: task.slice(0, 4000),
        baseBranch: typeof input.baseBranch === "string" && input.baseBranch.trim() ? input.baseBranch.slice(0, 200) : "main",
        publishPullRequest,
        createdAt: Date.now(),
      }));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Could not queue approval." }, { status: 409 });
    }
    return Response.json({ ok: true, approvalId, repoUrl, task: task.slice(0, 4000) });
  }

  /**
   * Resolve an approval pointer exactly once. Approve executes the frozen
   * input through delegate_coding_task (the same gated path as the
   * dashboard); reject resolves without starting anything.
   */
  private async resolveApproval(body: {
    threadKey?: unknown; approvalId?: unknown; approved?: unknown; decidedBy?: unknown;
  }): Promise<Response> {
    const { threadKey, approvalId, approved, decidedBy: rawDecidedBy } = body;
    if (typeof threadKey !== "string" || typeof approvalId !== "string" || typeof approved !== "boolean") {
      return Response.json({ error: "Invalid approval payload." }, { status: 400 });
    }
    const decidedBy = typeof rawDecidedBy === "string" && rawDecidedBy.trim() ? rawDecidedBy.slice(0, 200) : "unknown";
    if (approved) await this.reclaimRuns();
    const result = resolvePendingApproval(this.approvals, { threadKey, approvalId, approved, decidedBy }, Date.now());
    // Failed admission leaves the persisted approval pending and retryable.
    if (result.result === "approved") {
      if (!canStartRun(this.store.list())) {
        return Response.json({ error: "All coding runs are busy. Approve again when a slot frees." }, { status: 409 });
      }
      const record = this.approvals.find((a) => a.approvalId === approvalId && a.threadKey === threadKey);
      if (record && record.publishPullRequest && !this.env.GITHUB_TOKEN) {
        return Response.json({ error: "publishPullRequest was requested but GITHUB_TOKEN is not configured." }, { status: 400 });
      }
      if (record) {
        try {
          parseGitHubRepoUrl(record.repoUrl);
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Invalid repository URL." }, { status: 400 });
        }
      }
    }
    const approvals = pruneExpiredApprovals(result.approvals, Date.now());
    const record = result.result === "approved"
      ? approvals.find((approval) => approval.approvalId === approvalId)
      : undefined;
    const run = record ? createRun({
      runId: `agent-tool:${approvalId}`,
      sandboxId: makeSandboxId(record.repoUrl, record.task, approvalId),
      repoUrl: record.repoUrl,
      task: record.task,
      baseBranch: record.baseBranch ?? "main",
      publishPullRequest: record.publishPullRequest ?? false,
    }) : undefined;
    // One state write reserves capacity and records the decision before any await.
    this.setState({
      ...this.state,
      pendingApprovals: approvals,
      runs: run ? [...this.store.list(), run] : this.store.list(),
    });
    if (run) {
      const dispatch = async () => {
        try {
          const delegate = this.getTools()["delegate_coding_task"] as {
            execute: (input: unknown, options?: unknown) => Promise<unknown>;
          };
          await delegate.execute({
            repoUrl: run.repoUrl,
            task: run.task,
            baseBranch: run.baseBranch,
            publishPullRequest: run.publishPullRequest,
          }, { toolCallId: approvalId });
        } catch (error) {
          this.store.transition(run.runId, "error", {
            error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 4000),
          });
        }
      };
      void dispatch();
    }
    return Response.json({ result: result.result satisfies ResolveResult });
  }

  /** Cancel a retained run and destroy its sandbox. Returns null when unknown. */
  async cancelRun(runId: string): Promise<DelegatedRun | null> {
    const run = this.store.get(runId);
    if (!run) return null;
    if (!isActiveStatus(run.status)) return run;
    const updated = this.store.transition(runId, "cancelled");
    this.runControllers.get(runId)?.abort();
    this.postToSlackThread(`Run cancelled for ${run.repoUrl}.`);
    await this.destroySandbox(run.sandboxId);
    return updated;
  }

  /**
   * Slack post-back: thread-keyed orchestrators (`slack:{team}:{channel}:{ts}`)
   * relay run start + terminal outcome into the thread they came from.
   * Best-effort — the ack already went out and failure must not touch the run.
   */
  private postToSlackThread(text: string): void {
    const ids = parseSlackThreadName(this.name);
    const token = this.env.SLACK_BOT_TOKEN?.trim();
    if (!ids || !token) return;
    this.ctx.waitUntil(
      fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: ids.channelId, thread_ts: ids.threadTs, text: text.slice(0, 3000) }),
      })
        .then((response) => {
          if (!response.ok) console.error(`Slack post-back failed (${response.status})`);
        })
        .catch(() => { /* best-effort */ }),
    );
  }

  private async destroySandbox(sandboxId: string): Promise<void> {
    try {
      const { getSandbox } = await import("@cloudflare/sandbox");
      await getSandbox(this.env.Sandbox, sandboxId).destroy();
    } catch (error) {
      // Cleanup failure must not overwrite the recorded outcome.
      console.warn(`Failed to destroy sandbox ${sandboxId}: ${redactSecrets(String(error))}`);
    }
  }

  private async reclaimRuns(): Promise<void> {
    const { runs, reclaimed } = reclaimStaleRuns(this.store.list(), Date.now());
    if (reclaimed.length === 0) return;
    this.setState({ ...this.state, runs });
    await Promise.all(runs.filter((run) => reclaimed.includes(run.runId)).map(async (run) => {
      this.runControllers.get(run.runId)?.abort();
      await this.destroySandbox(run.sandboxId);
    }));
  }

  async clearRuns(): Promise<void> {
    // Pending Slack approvals survive Clear: they are not run history, and
    // dropping them would silently strand a queued card's pointer.
    const runs = this.store.list();
    const removed = new Set(runs.map((run) => run.runId));
    await Promise.all(runs.filter((run) => isActiveStatus(run.status))
      .map((run) => this.cancelRun(run.runId)));
    // Do not drop runs admitted while sandbox cleanup was awaiting I/O.
    this.setState({ ...this.state, runs: this.store.list().filter((run) => !removed.has(run.runId)) });
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/approvals") {
      let approvalBody: unknown;
      try {
        approvalBody = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      if (typeof approvalBody !== "object" || approvalBody === null || Array.isArray(approvalBody)) {
        return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
      }
      return this.resolveApproval(approvalBody as Record<string, unknown>);
    }
    const match = url.pathname.match(/^\/api\/runs(?:\/([^/]+))?$/);
    if (!match) {
      return super.onRequest(request);
    }
    if (request.method === "POST" && url.pathname === "/api/runs") {
      let queueBody: unknown;
      try {
        queueBody = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      if (typeof queueBody !== "object" || queueBody === null || Array.isArray(queueBody)) {
        return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
      }
      return this.queueSlackRun(queueBody as Record<string, unknown>);
    }
    if (request.method !== "GET" && request.method !== "DELETE") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    let id: string | null;
    try {
      id = match[1] ? decodeURIComponent(match[1]) : null;
    } catch {
      return Response.json({ error: "Invalid run ID." }, { status: 400 });
    }
    await this.reclaimRuns();
    if (request.method === "GET" && id === null) {
      return Response.json({ runs: this.store.list() });
    }
    if (request.method === "DELETE" && id === null) {
      await this.clearRuns();
      return Response.json({ ok: true });
    }
    if (id !== null && request.method === "GET") {
      const run = this.store.get(id);
      return run ? Response.json({ run }) : Response.json({ error: "Run not found." }, { status: 404 });
    }
    if (id !== null && request.method === "DELETE") {
      const run = await this.cancelRun(id);
      return run ? Response.json({ run }) : Response.json({ error: "Run not found." }, { status: 404 });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
}
