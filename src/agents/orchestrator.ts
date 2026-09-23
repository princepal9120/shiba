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
  type RunPatch,
  type RunStatus,
} from "../runs.js";
import { makeReceipt } from "../receipts.js";
import {
  createPendingApproval,
  isApprovalExpired,
  isJsonObject,
  pruneExpiredApprovals,
  recordApprovalExecution,
  resolvePendingApproval,
  type PendingApproval,
  type ResolveResult,
} from "../pending-approvals.js";
import { makeSandboxId, parseGitHubRepoUrl, redactSecrets } from "../security.js";
import { executeEmailApproval, unqueueEmailApprovalDraft } from "../email-approvals.js";
import { ADDRESS_RE } from "../mailbox-store.js";
import { registeredMailbox } from "../mailbox-do.js";
import { classifyExecutorError, classifyRunError, runErrorWire, type RunErrorCode, type RunErrorWire } from "../run-errors.js";
import { parseSlackThreadName } from "../slack-thread.js";
import { evaluateResultQuality } from "../result-quality.js";
import { HARNESS_DEFAULT_MODELS, allowedHostsFor, resolveHarness } from "../harness/index.js";
import { OpenCodeAgent } from "./opencode-agent.js";

export interface OrchestratorState {
  runs: DelegatedRun[];
  pendingApprovals?: PendingApproval[];
}

/** A classified error lands as its matching terminal status. */
function terminalStatusFor(code: RunErrorCode): RunStatus {
  return code === "cancelled" ? "cancelled" : code === "outcome_unknown" ? "unknown" : "error";
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
    // Approved email approvals execute through ctx.waitUntil — an
    // eviction between the persisted decision and the dispatch leaves
    // `approved` with no `execution` and nothing to re-drive it (a
    // silent no-send). Re-drive what a restart proves safe: a delete
    // is idempotent, and a draft-backed send's claim CAS refuses what
    // the first attempt already finished. An unanchored composed send
    // could have transmitted before the restart — stamp its outcome
    // unknown instead of risking a second copy.
    for (const approval of this.approvals) {
      if (approval.status !== "approved" || approval.execution !== undefined) {
        continue;
      }
      const payload = isJsonObject(approval.payload) ? approval.payload : {};
      const draftId = typeof payload.draft_id === "string" ? payload.draft_id.trim() : "";
      if (approval.kind === "email_send" && draftId === "") {
        this.writeApprovals(recordApprovalExecution(this.approvals, {
          threadKey: approval.threadKey,
          approvalId: approval.approvalId,
          execution: {
            status: "failed",
            error: "Execution interrupted by orchestrator restart — outcome unknown. Inspect the mailbox before re-sending.",
            executedAt: Date.now(),
          },
        }));
        continue;
      }
      if (approval.kind === "email_send" || approval.kind === "email_delete") {
        this.dispatchApprovedEmail(approval);
      }
    }
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
    const finish = (status: RunStatus, patch?: RunPatch): DelegatedRun | null => {
      // Fenced write: a stale generation (cancel/reclaim landed while the
      // child was running) drops the transition AND every side effect.
      const updated = this.store.transition(runId, status, patch, generation);
      if (updated === null) return null;
      // Slack-originated runs get the outcome back in the thread; the
      // summary carries the PR link when one was published.
      if (status === "completed") {
        this.postToSlackThread(`Run completed for ${fullInput.repoUrl}\n${patch?.summary?.slice(0, 1500) ?? ""}`.trim());
      } else if (status === "error" || status === "unknown") {
        const wire = runErrorWire(patch?.errorCode ?? "internal_error");
        this.postToSlackThread(
          `${status === "unknown" ? "Run outcome unknown" : "Run failed"} for ${fullInput.repoUrl}\n${wire.userMessage}\n${patch?.error?.slice(0, 1000) ?? ""}`.trim(),
        );
      }
      return updated;
    };
    const running = this.store.transition(runId, "running", undefined, this.store.get(runId)?.generation);
    if (running === null || running.status !== "running") {
      return `Run ${runId} did not start — it is already ${this.store.get(runId)?.status ?? "missing"}.`;
    }
    const generation = running.generation;
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
          const finished = finish("completed", { summary: output.slice(0, 4000), diff: parsed?.diff ? parsed.diff.slice(0, 20000) : undefined });
          // TypeSafe Score: grade the run quality (fail-open — never blocks completion).
          // Terminal runs are immutable (transitionRun refuses them), so the
          // grade lands as a "grade" receipt on the finished record — never
          // as a second transition, which would be silently discarded.
          // A dropped finish means the run went terminal mid-flight — do not
          // grade stale output onto a cancelled/reclaimed record.
          const tsKey = this.env.TYPESAFE_API_KEY?.trim() ?? "";
          if (finished !== null && tsKey) {
            evaluateResultQuality(tsKey, output.slice(0, 2000)).then((quality) => {
              if (!quality) return;
              const run = this.store.get(runId);
              if (run && run.status === "completed") {
                this.store.replace(
                  runId,
                  recordReceipt(run, makeReceipt("grade", `Result quality: ${quality.level} (score ${quality.score.toFixed(2)}, confidence ${quality.confidence.toFixed(2)}).`)),
                );
              }
            }).catch(() => { /* fail-open */ });
          }
          return output;
        }
        const failure = classifyExecutorError(new Error(parsed?.summary ?? output.slice(0, 4000)));
        finish(terminalStatusFor(failure.code), {
          summary: output.slice(0, 4000),
          error: redactSecrets(parsed?.summary ?? output.slice(0, 4000)).slice(0, 4000),
          errorCode: failure.code,
        });
        return output;
      }
      const message = `Coding run failed: ${JSON.stringify(output).slice(0, 2000)}`;
      const failure = classifyRunError(new Error(message));
      finish(terminalStatusFor(failure.code), { error: redactSecrets(message), errorCode: failure.code });
      throw new Error(message);
    } catch (error) {
      const failure = classifyRunError(error);
      finish(terminalStatusFor(failure.code), {
        error: redactSecrets(failure.message).slice(0, 4000),
        errorCode: failure.code,
      });
      throw error;
    } finally {
      this.runControllers.delete(runId);
      await this.destroySandbox(sandboxId);
    }
  }

  /**
   * Queue a task as a pending approval: the exact delegation input is
   * frozen at queue time and nothing executes until a human resolves
   * the pointer via POST /api/approvals. Email-kind approvals freeze a
   * mailbox payload instead of a run input.
   */
  private async queueSlackRun(input: { repoUrl?: unknown; task?: unknown; baseBranch?: unknown; publishPullRequest?: unknown; threadKey?: unknown; kind?: unknown; mailbox?: unknown; payload?: unknown }): Promise<Response> {
    const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : "run";
    if (kind === "email_send" || kind === "email_delete") {
      return this.queueEmailApprovalRecord(kind, input);
    }
    if (kind !== "run") {
      return Response.json({ error: `Unknown approval kind "${kind}".` }, { status: 400 });
    }
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
   * Email-kind approval (megaplan T7): the frozen send/delete payload is
   * stored verbatim plus its owning mailbox — the single source the
   * executor routes and sends against. `repoUrl`/`task` stay populated
   * as the human-readable summary dashboard cards and audit rows show.
   */
  private async queueEmailApprovalRecord(kind: "email_send" | "email_delete", input: { mailbox?: unknown; payload?: unknown; threadKey?: unknown }): Promise<Response> {
    const mailbox = typeof input.mailbox === "string" ? input.mailbox.trim() : "";
    if (!ADDRESS_RE.test(mailbox)) {
      return Response.json({ error: "mailbox must be a valid email address." }, { status: 400 });
    }
    if (!isJsonObject(input.payload)) {
      return Response.json({ error: "payload must be a JSON object." }, { status: 400 });
    }
    const fields = input.payload;
    const required = kind === "email_send" ? ["to_addr", "subject", "body_text"] : ["email_id"];
    for (const field of required) {
      if (typeof fields[field] !== "string" || (fields[field] as string).trim() === "") {
        return Response.json({ error: `payload.${field} must be a non-empty string.` }, { status: 400 });
      }
    }
    // Address-format check fails at intake, not post-approval at the binding.
    if (kind === "email_send" && !ADDRESS_RE.test((fields.to_addr as string).trim())) {
      return Response.json({ error: "payload.to_addr must be a valid email address." }, { status: 400 });
    }
    // The same registration invariant the MCP path enforces via
    // requireMailbox: an approval's From must be a registered mailbox.
    const registration = await registeredMailbox(this.env, mailbox);
    if (registration === null) {
      return Response.json({ error: `mailbox is not registered: ${mailbox}` }, { status: 400 });
    }
    const approvalId = crypto.randomUUID();
    const threadKey = typeof input.threadKey === "string" && input.threadKey.trim() ? input.threadKey.trim() : "default";
    const subject = typeof fields.subject === "string" ? fields.subject : "";
    const task = kind === "email_send"
      ? `Send email to ${String(fields.to_addr)}: ${subject}`
      : `Delete email ${String(fields.email_id)}${subject ? ` "${subject}"` : ""}`;
    try {
      this.writeApprovals(createPendingApproval(this.approvals, {
        threadKey,
        approvalId,
        repoUrl: mailbox,
        task: task.slice(0, 4000),
        kind,
        payload: { ...fields, mailbox },
        createdAt: Date.now(),
      }));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Could not queue approval." }, { status: 409 });
    }
    return Response.json({ ok: true, approvalId, kind, mailbox });
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
    const now = Date.now();
    const result = resolvePendingApproval(this.approvals, { threadKey, approvalId, approved, decidedBy }, now);
    // Failed admission leaves the persisted approval pending and retryable.
    if (result.result === "approved") {
      const record = this.approvals.find((a) => a.approvalId === approvalId && a.threadKey === threadKey);
      // Email-kind approvals skip every run gate — no sandbox capacity,
      // no repo URL, no publish flag. They execute a mailbox payload.
      const isEmail = record !== undefined && (record.kind === "email_send" || record.kind === "email_delete");
      if (!isEmail) {
        if (!canStartRun(this.store.list())) {
          return Response.json({ error: "All coding runs are busy. Approve again when a slot frees." }, { status: 409 });
        }
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
    }
    // Captured before the prune drops them: an expired email_send still
    // owns a `queued` draft, and once its pointer is gone nothing else
    // can reach the locked row — the sweep below releases it through the
    // same unqueue seam a rejection uses. Covers both drops: the
    // expired-pointer resolve (removed from `result.approvals` already)
    // and every other expired pending the prune filters out.
    const expiredSends = this.expiredEmailSends(now);
    const approvals = pruneExpiredApprovals(result.approvals, now);
    const record = result.result === "approved"
      ? approvals.find((approval) => approval.approvalId === approvalId)
      : undefined;
    const rejectedEmail =
      result.result === "rejected"
        ? approvals.find((approval) => approval.approvalId === approvalId && approval.kind === "email_send")
        : undefined;
    const isEmailRecord = record !== undefined && (record.kind === "email_send" || record.kind === "email_delete");
    const run = record && !isEmailRecord ? createRun({
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
          const failure = classifyRunError(error);
          this.store.transition(run.runId, terminalStatusFor(failure.code), {
            error: redactSecrets(failure.message).slice(0, 4000),
            errorCode: failure.code,
          });
        }
      };
      void dispatch();
    }
    if (record && isEmailRecord) {
      this.dispatchApprovedEmail(record);
    }
    if (rejectedEmail) {
      // Rejecting frees the queued draft back to `draft` — otherwise the
      // row strands `queued` behind an approval that can never re-resolve.
      this.releaseEmailApprovalDrafts([rejectedEmail]);
    }
    // Expired email approvals leave their queued drafts the same way —
    // an approval that aged out can never be resolved, so its draft
    // would sit `queued` forever without this compensating release.
    this.releaseEmailApprovalDrafts(expiredSends);
    return Response.json({ result: result.result satisfies ResolveResult });
  }

  /**
   * Execute an approved email approval and stamp the outcome back onto
   * the persisted record — the record is the only durable account of a
   * runless execution. Shared by the resolve path and the onStart
   * recovery pass for approved-but-never-executed records.
   */
  private dispatchApprovedEmail(record: PendingApproval): void {
    const { approvalId, threadKey } = record;
    const dispatch = async () => {
      try {
        await executeEmailApproval(this.env, record);
        // The record is the only durable account of this runless
        // execution — the outcome lands on it, not only in logs.
        this.writeApprovals(recordApprovalExecution(this.approvals, {
          threadKey,
          approvalId,
          execution: { status: "executed", executedAt: Date.now() },
        }));
      } catch (error) {
        // The pointer is already spent — the failure is written back
        // onto the persisted record so an approved-but-failed send/
        // delete leaves durable state, not a misleading "recorded" reply.
        const message = redactSecrets(String(error)).slice(0, 4000);
        console.error(`Email approval ${approvalId} execution failed`, message);
        this.writeApprovals(recordApprovalExecution(this.approvals, {
          threadKey,
          approvalId,
          execution: { status: "failed", error: message, executedAt: Date.now() },
        }));
      }
    };
    const pending = dispatch();
    // waitUntil keeps the DO alive through the send; without a ctx
    // (tests) the promise still runs to its own settle point.
    if (typeof this.ctx === "object" && this.ctx !== null && "waitUntil" in this.ctx) {
      this.ctx.waitUntil(pending);
    } else {
      void pending;
    }
  }

  /** Cancel a retained run and destroy its sandbox. Returns null when unknown. */
  async cancelRun(runId: string): Promise<DelegatedRun | null> {
    const run = this.store.get(runId);
    if (!run) return null;
    if (!isActiveStatus(run.status)) return run;
    // Cancellation is deliberately unfenced: it is allowed to win races.
    const updated = this.store.transition(runId, "cancelled", { errorCode: "cancelled" });
    this.runControllers.get(runId)?.abort();
    this.postToSlackThread(`Run cancelled for ${run.repoUrl}. If a publish was in flight it may still land — check the repository before retrying.`);
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

  /** Wire projection for API responses: errorCode -> {status, code, userMessage}. */
  private serializeRun(run: DelegatedRun): DelegatedRun & { errorWire?: RunErrorWire } {
    return run.errorCode ? { ...run, errorWire: runErrorWire(run.errorCode) } : run;
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

  /** Pending email_send approvals past TTL — the records a prune drops. */
  private expiredEmailSends(now: number): PendingApproval[] {
    return this.approvals.filter(
      (approval) =>
        approval.status === "pending" &&
        approval.kind === "email_send" &&
        isApprovalExpired(approval, now),
    );
  }

  /**
   * Release each record's queued draft through the same unqueue seam a
   * rejection uses. `queued` rows are immutable to every other surface
   * (`updateDraft`/`markDraftQueued` refuse non-`draft` rows), so a
   * draft locked behind an approval that can no longer resolve is
   * stranded forever without this. Best-effort: a failure is logged,
   * never fatal to the pointer path that triggered it.
   */
  private releaseEmailApprovalDrafts(records: PendingApproval[]): void {
    if (records.length === 0) return;
    const releases = Promise.all(
      records.map((record) =>
        unqueueEmailApprovalDraft(this.env, record).catch((error) => {
          console.error(
            `Email approval ${record.approvalId} draft release failed`,
            redactSecrets(String(error)),
          );
        }),
      ),
    );
    if (typeof this.ctx === "object" && this.ctx !== null && "waitUntil" in this.ctx) {
      this.ctx.waitUntil(releases);
    } else {
      void releases;
    }
  }

  /**
   * GET the live approval pointers — the dashboard's Approvals surface
   * lists them to a human who decides via POST. Expired pendings are
   * pruned out of state here too, not merely hidden: this is the poll
   * path a human dashboard session drives, so it runs the same sweep
   * the resolve path does and frees any draft whose email approval
   * aged out. Decided records are dropped from the listing — a
   * resolved pointer must never be re-listed.
   */
  private listApprovals(): Response {
    const now = Date.now();
    const expiredSends = this.expiredEmailSends(now);
    const pruned = pruneExpiredApprovals(this.approvals, now);
    if (pruned.length !== this.approvals.length) {
      this.writeApprovals(pruned);
      this.releaseEmailApprovalDrafts(expiredSends);
    }
    return Response.json({
      approvals: pruned.filter((approval) => approval.status === "pending"),
    });
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/approvals" && request.method === "GET") {
      return this.listApprovals();
    }
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
    if (url.pathname === "/api/approvals") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
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
      return Response.json({ runs: this.store.list().map((run) => this.serializeRun(run)) });
    }
    if (request.method === "DELETE" && id === null) {
      await this.clearRuns();
      return Response.json({ ok: true });
    }
    if (id !== null && request.method === "GET") {
      const run = this.store.get(id);
      return run
        ? Response.json({ run: this.serializeRun(run) })
        : Response.json({ error: "Run not found." }, { status: 404 });
    }
    if (id !== null && request.method === "DELETE") {
      const run = await this.cancelRun(id);
      return run
        ? Response.json({ run: this.serializeRun(run) })
        : Response.json({ error: "Run not found." }, { status: 404 });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
}
