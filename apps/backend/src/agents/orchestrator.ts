/**
 * Planning and delegation agent. It never edits repositories itself:
 * the only repository-touching capability is delegate_coding_task, which
 * requires explicit human approval and runs inside an isolated Sandbox
 * container driven by OpenCodeAgent.
 */
import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import { tool, type ToolSet } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import type { Env } from "../env.js";
import {
  formatAgentToolInput,
  parseAgentResult,
  type CodingTaskInput,
} from "../opencode-input.js";
import {
  MAX_CONCURRENT_RUNS,
  RUN_DEADLINE_MS,
  RunStore,
  AGENT_PRINCIPAL_HEADER,
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
  decidedApprovals,
  isApprovalExpired,
  isJsonObject,
  pruneExpiredApprovals,
  recordApprovalExecution,
  resolvePendingApproval,
  type PendingApproval,
  type ResolveResult,
} from "../pending-approvals.js";
import { makeSandboxId, parseGitHubRepoUrl, redactSecrets } from "../security.js";
import { emailApprovalDraftRef, executeEmailApproval, PostTransmitError, releaseRestartedDraftClaim, unqueueEmailApprovalDraft } from "../email-approvals.js";
import { ADDRESS_RE, type MailboxRecord } from "../mailbox-store.js";
import { mailboxDirectoryStub, mailboxStub, registeredMailbox } from "../mailbox-do.js";
import { approvalCardText, buildApprovalBlocks, type ApprovalCardInput } from "../slack-approval.js";
import {
  destroyManagedContainer,
  leakedContainers,
  setLeakPersistence,
} from "../sandbox/lifecycle.js";
import { runWorkerEffect, toRunFailure, tryRunPromise } from "../effect/runtime.js";
import { classifyExecutorError, classifyRunError, runErrorWire, toTaggedError, type RunErrorCode, type RunErrorWire } from "../run-errors.js";
import { DEFAULT_ORCHESTRATOR_MODEL, distillSession } from "../session-distill.js";
import { parseSlackThreadName } from "../slack-thread.js";
import { postToChatThread } from "../chat-lane.js";
import { evaluateResultQuality } from "../result-quality.js";
import { evaluateSessionTriage } from "../session-triage.js";
import {
  slackRunCancelled,
  slackRunCompleted,
  slackRunFailed,
  slackRunStarted,
} from "../slack-persona.js";
import { postSlackMessage } from "../slack.js";
import { extractPullRequestUrl } from "../transcript.js";
import { HARNESS_DEFAULT_MODELS, allowedHostsFor, resolveHarness } from "../harness/index.js";
import { describeRoute, isApprovedRoute, type ApprovedRoute } from "../model-connections.js";
import { readModelConfig, revalidateCodingRoute, resolveCodingRoute } from "../model-policy.js";
import { OpenCodeAgent } from "./opencode-agent.js";

export interface OrchestratorState {
  runs: DelegatedRun[];
  pendingApprovals?: PendingApproval[];
  /** Leaks recorded before a hibernation still get their destroy retried. */
  leakedContainers?: Record<string, { sandboxId: string; leakedAt: number; error: string }>;
}

/** A classified error lands as its matching terminal status. */
function terminalStatusFor(code: RunErrorCode): RunStatus {
  // Indeterminate family: the run ended but its side effects are unverified —
  // the record is "unknown" so the wire projection and the dashboard agree.
  return code === "cancelled"
    ? "cancelled"
    : code === "outcome_unknown" || code === "container_lost"
      ? "unknown"
      : "error";
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
  connectionId: z
    .string()
    .optional()
    .describe(
      "Model connection id (conn_*) from the deployment's connection catalog. " +
        "Defaults to the deployment's implicit gateway/secret default.",
    ),
});

type DelegateInput = z.infer<typeof delegateInputSchema>;

/**
 * Floor between full-mailbox stale-draft sweeps. The sweep is a
 * backstop, not a per-poll job — the dashboard polls approvals every
 * 10s and each run wakes every registered mailbox DO, so it fires at
 * most this often per orchestrator lifetime. A touch that just
 * dropped expired email sends passes `force` — their drafts need
 * freeing now, not at the next tick.
 */
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Accept a scraped "Pull request:" URL only when it points at a PR in the
 * run's own repository — transcript text is agent-influenced, so a link to
 * any other repo is rejected instead of posted to Slack.
 */
function repoPullUrl(output: string, repoUrl: string): string | undefined {
  const url = extractPullRequestUrl(output);
  if (!url) return undefined;
  // Structural match, not a prefix check: ../ or %2e%2e segments could
  // otherwise smuggle a different repo past startsWith.
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url);
  if (!match) return undefined;
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  return match[1]!.toLowerCase() === owner.toLowerCase() && match[2]!.toLowerCase() === repo.toLowerCase()
    ? url
    : undefined;
}

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

  /**
   * Wall-clock time of this lifetime's last stale-draft sweep —
   * volatile on purpose: an evicted DO re-sweeps once on its next
   * approval touch, which is the correct post-restart behavior anyway.
   */
  private lastStaleSweepAt: number | undefined;

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
      const updated = this.store.transition(run.runId, "unknown", {
        error: "Execution interrupted by orchestrator restart. Inspect repository state before retrying.",
        errorCode: "outcome_unknown",
      });
      if (updated !== null) this.postOutcomeUnknown(updated);
    }
    // Teardown runs in the background: awaiting container I/O here would block the DO's start.
    const teardown = Promise.all(interrupted.map((run) => this.destroySandbox(run.sandboxId)));
    if (typeof this.ctx === "object" && this.ctx !== null && "waitUntil" in this.ctx) {
      this.ctx.waitUntil(teardown);
    } else {
      void teardown;
    }
    // Before anything re-drives, free the draft claims a dead attempt
    // could leave behind: a `sending` row at DO start belongs to a
    // dispatch that died with the last lifetime — claims are only
    // minted by this DO's dispatches (queueEmailApproval pins the
    // shared instance) and none has run yet this lifetime, so the
    // release cannot steal a live claim. `unqueue` refuses `sending`
    // and the dead attempt's own `release` died with it, so this is
    // the only surface that can return the row to `draft`. A freed
    // claim means the dead attempt may have transmitted — stamp its
    // outcome unknown like a draftless send instead of re-driving.
    for (const approval of this.approvals) {
      if (
        approval.status !== "approved" ||
        approval.kind !== "email_send" ||
        approval.execution !== undefined
      ) {
        continue;
      }
      let released = false;
      try {
        released = await releaseRestartedDraftClaim(this.env, approval);
      } catch (error) {
        console.warn(
          `Email approval ${approval.approvalId} claim release failed`,
          redactSecrets(String(error)),
        );
      }
      if (released && approval.execution === undefined) {
        this.writeApprovals(recordApprovalExecution(this.approvals, {
          threadKey: approval.threadKey,
          approvalId: approval.approvalId,
          execution: {
            status: "failed",
            error: "Execution interrupted by orchestrator restart while the draft was claimed 'sending' — outcome unknown (the dead attempt may have transmitted). The claim was released; inspect the mailbox before re-sending.",
            executedAt: Date.now(),
          },
        }));
      }
    }
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
    this.sweepStaleDrafts(true);
  }

  override getModel(): string {
    return this.env.ORCHESTRATOR_MODEL || DEFAULT_ORCHESTRATOR_MODEL;
  }

  override getSystemPrompt(): string {
    return [
      "You are AI Coworker, a planning and delegation agent.",
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

  /**
   * Resolve and freeze the exact route the human approves (spec §4): the
   * per-run connection/model override wins, then the deployment default.
   * An inadmissible connection/model/harness combination throws here —
   * before the approval card — so a bad route never starts a container.
   */
  private async resolveRoute(input: DelegateInput): Promise<{ harness: string; codingModel: string; route: ApprovedRoute }> {
    const { harness, codingModel } = this.resolveHarnessAndModel(input);
    const snapshot = await readModelConfig(this.env);
    const route = resolveCodingRoute(snapshot, {
      connectionId: input.connectionId?.trim() || null,
      model: codingModel,
      harness,
    });
    return { harness, codingModel, route };
  }

  /**
   * The run pipeline as an Effect program (spec B6), run to a Promise at
   * the tool boundary via `runWorkerEffect`. Observable behavior is
   * unchanged: the same checkpoint order, fenced writes, Slack posts,
   * classification, and cleanup; failures cross the boundary as
   * `RunFailure` carrying the same code + message the old catch block
   * classified.
   *
   * Abort semantics: the caller/run-cancel signals reach only the child —
   * an abort never interrupts the program's fiber, so a child that still
   * resolves after an abort returns its output (the fenced finish drops
   * the write if the run went terminal), and an abort landing during
   * cleanup cannot flip a completed run to cancelled. Fiber interruption
   * — from any future interrupter — does propagate to the child through
   * the tryRunPromise signal the way `effectWithSignal` does.
   */
  private async executeDelegatedTask(
    input: DelegateInput,
    childExecute: NonNullable<ReturnType<typeof agentTool>["execute"]>,
    toolCallId: string | undefined,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    // A pre-aborted call fails fast with the caller's reason, before the
    // program exists — same synchronous checkpoint as before.
    abortSignal?.throwIfAborted();
    const program = Effect.gen({ self: this }, function* () {
      yield* Effect.promise(() => this.reclaimRuns());
      yield* Effect.sync(() => abortSignal?.throwIfAborted());
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
      // Resolve harness + model + connection HERE: the human approves the
      // exact route that will execute. An approval-dispatched run reuses the
      // route frozen on its pointer verbatim; a fresh tool call resolves it
      // now. Either way the route is revalidated just before dispatch — a
      // revoked connection fails the run honestly, never a substitution.
      const frozen = reserved?.route;
      const { harness: resolvedHarness, codingModel, route } = frozen !== undefined && isApprovedRoute(frozen)
        ? { harness: frozen.harness, codingModel: frozen.modelId, route: frozen }
        : yield* Effect.promise(() => this.resolveRoute(input));
      const sandboxId = makeSandboxId(input.repoUrl, input.task, callId);
      // Slack thread ids ride the DO name, not the queue body — recovering
      // them here lets the child post progress without new queue plumbing.
      const slackIds = parseSlackThreadName(this.name);
      const fullInput: CodingTaskInput = {
        repoUrl: input.repoUrl,
        task: input.task,
        baseBranch: input.baseBranch,
        publishPullRequest: input.publishPullRequest,
        sandboxId,
        codingModel,
        harness: resolvedHarness as CodingTaskInput["harness"],
        route,
        ...(slackIds ? { slackThread: { channelId: slackIds.channelId, threadTs: slackIds.threadTs } } : {}),
      };
      if (!reserved) this.store.add(
        createRun({
          runId,
          sandboxId,
          repoUrl: fullInput.repoUrl,
          task: fullInput.task,
          baseBranch: fullInput.baseBranch,
          publishPullRequest: fullInput.publishPullRequest,
          route,
        }),
      );
      // Chat-originated runs get the outcome back in the thread in the
      // coworker voice; the summary carries the PR link when one was published.
      const finish = (status: RunStatus, patch?: RunPatch, threadText?: string): DelegatedRun | null => {
        // Fenced write: a stale generation (cancel/reclaim landed while the
        // child was running) drops the transition AND every side effect.
        const updated = this.store.transition(runId, status, patch, generation);
        if (updated === null) return null;
        if (threadText) {
          this.postToThread(threadText);
        }
        // Megaplan T10: a retained run landing completed/error distills its
        // transcript into long-term memory — best-effort under waitUntil.
        if (status === "completed" || status === "error") {
          this.dispatchSessionDistill(updated);
        }
        return updated;
      };
      const running = this.store.transition(runId, "running", undefined, this.store.get(runId)?.generation);
      if (running === null || running.status !== "running") {
        return `Run ${runId} did not start — it is already ${this.store.get(runId)?.status ?? "missing"}.`;
      }
      const generation = running.generation;
      // Durable backstop: reclaim fires at the deadline even when no request ever arrives.
      yield* Effect.promise(async () => {
        try {
          await this.schedule(Math.ceil(RUN_DEADLINE_MS / 1000) + 60, "reclaimRuns");
        } catch (error) {
          console.warn(`Run ${runId} reclaim schedule failed`, redactSecrets(String(error)));
        }
      });
      this.postToThread(
        slackRunStarted({ repoUrl: fullInput.repoUrl, baseBranch: fullInput.baseBranch, harness: fullInput.harness }),
      );
      const intakeTsKey = this.env.TYPESAFE_API_KEY?.trim() ?? "";
      if (intakeTsKey) {
        yield* Effect.forkDetach(
          tryRunPromise(() => evaluateSessionTriage(intakeTsKey, fullInput.task, fullInput.repoUrl)).pipe(
            Effect.flatMap((triage) =>
              Effect.sync(() => {
                if (!triage) return;
                const r = this.store.get(runId);
                if (r && r.status === "running") {
                  this.store.replace(
                    runId,
                    recordReceipt(
                      r,
                      makeReceipt(
                        "triage",
                        `TypeSafe Jev: ${triage.complexity} complexity (${triage.risk} risk, confidence ${triage.confidence.toFixed(2)}).`,
                      ),
                    ),
                  );
                }
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        );
      }
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          this.runControllers.set(runId, controller);
          return abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal;
        }),
        (signal) =>
          Effect.gen({ self: this }, function* () {
            yield* Effect.sync(() => signal.throwIfAborted());
            // Just before dispatch: the connection may have been disabled or
            // deleted since approval. Fail honestly — never substitute.
            const snapshot = yield* Effect.promise(() => readModelConfig(this.env));
            const routeProblem = revalidateCodingRoute(snapshot, route);
            if (routeProblem !== null) {
              throw new Error(`Approved route is no longer available: ${routeProblem}`);
            }
            const output = yield* tryRunPromise((fiberSignal) =>
              childExecute(formatAgentToolInput(fullInput), {
                toolCallId: callId,
                // The caller's signal and the run-cancel controller reach the
                // child exactly as before; fiberSignal additionally fires if
                // the program's fiber itself is interrupted.
                abortSignal: AbortSignal.any([signal, fiberSignal]),
              }),
            );
            if (typeof output === "string") {
              // The child reports status in a structured envelope. Trusting the
              // transport type instead would mark failed runs "completed".
              const parsed = parseAgentResult(output);
              if (parsed?.status === "completed") {
                const finished = finish(
                  "completed",
                  { summary: output.slice(0, 4000), diff: parsed?.diff ? parsed.diff.slice(0, 20000) : undefined, pullUrl: parsed.pullUrl },
                  slackRunCompleted({
                    repoUrl: fullInput.repoUrl,
                    summary: redactSecrets(parsed.summary ?? "").slice(0, 4000),
                    changedFiles: parsed.changedFiles?.length,
                    // The envelope carries pullUrl; the transcript scrape is a
                    // fallback for older children — never the source of truth.
                    // A scraped link is accepted only inside the run's own repo,
                    // so a "Pull request: https://evil" line cannot spoof it.
                    pullUrl: parsed.pullUrl ?? repoPullUrl(output, fullInput.repoUrl),
                  }),
                );
                // TypeSafe Score: grade the run quality (fail-open — never
                // blocks completion). Terminal runs are immutable
                // (transitionRun refuses them), so the grade lands as a
                // "grade" receipt on the finished record — never as a second
                // transition, which would be silently discarded. A dropped
                // finish means the run went terminal mid-flight — do not
                // grade stale output onto a cancelled/reclaimed record.
                const tsKey = this.env.TYPESAFE_API_KEY?.trim() ?? "";
                if (finished !== null && tsKey) {
                  yield* Effect.forkDetach(
                    tryRunPromise(() => evaluateResultQuality(tsKey, output.slice(0, 2000))).pipe(
                      Effect.flatMap((quality) =>
                        Effect.sync(() => {
                          if (!quality) return;
                          const run = this.store.get(runId);
                          if (run && run.status === "completed") {
                            this.store.replace(
                              runId,
                              recordReceipt(run, makeReceipt("grade", `Result quality: ${quality.level} (score ${quality.score.toFixed(2)}, confidence ${quality.confidence.toFixed(2)}).`)),
                            );
                          }
                        }),
                      ),
                      // Detached daemon: dies with no scope, never blocks the
                      // pipeline, and stays fail-open like the old .catch.
                      Effect.catchCause(() => Effect.void),
                    ),
                  );
                }
                return output;
              }
              const failure = classifyExecutorError(new Error(parsed?.summary ?? output.slice(0, 4000)));
              const failureStatus = terminalStatusFor(failure.code);
              finish(failureStatus, {
                summary: output.slice(0, 4000),
                error: redactSecrets(parsed?.summary ?? output.slice(0, 4000)).slice(0, 4000),
                errorCode: failure.code,
              }, slackRunFailed({
                repoUrl: fullInput.repoUrl,
                userMessage: runErrorWire(failure.code).userMessage,
                detail: redactSecrets(parsed?.summary ?? output.slice(0, 1000)).slice(0, 1000),
                unknown: failureStatus === "unknown",
              }));
              return output;
            }
            const message = `Coding run failed: ${JSON.stringify(output).slice(0, 2000)}`;
            const failure = classifyRunError(new Error(message));
            const failureStatus = terminalStatusFor(failure.code);
            finish(failureStatus, { error: redactSecrets(message), errorCode: failure.code }, slackRunFailed({
              repoUrl: fullInput.repoUrl,
              userMessage: runErrorWire(failure.code).userMessage,
              detail: message.slice(0, 1000),
              unknown: failureStatus === "unknown",
            }));
            return yield* Effect.fail(toTaggedError(failure.code, message));
          }).pipe(
            // The old catch block: every in-flight failure or interruption
            // still lands its fenced terminal write — classified exactly as
            // the boundary will report it — before the original cause
            // continues out as the rejection.
            Effect.catchCause((cause) => {
              const failure = toRunFailure(cause);
              const failureStatus = terminalStatusFor(failure.code);
              return Effect.andThen(
                Effect.sync(() => {
                  finish(failureStatus, {
                    error: redactSecrets(failure.message).slice(0, 4000),
                    errorCode: failure.code,
                  }, slackRunFailed({
                    repoUrl: fullInput.repoUrl,
                    userMessage: runErrorWire(failure.code).userMessage,
                    detail: redactSecrets(failure.message).slice(0, 1000),
                    unknown: failureStatus === "unknown",
                  }));
                }),
                Effect.failCause(cause),
              );
            }),
          ),
        // Release = the old finally: runs on success, failure, and interruption.
        () =>
          Effect.promise(async () => {
            this.runControllers.delete(runId);
            await this.destroySandbox(sandboxId);
          }),
      );
    });
    return runWorkerEffect(program);
  }

  /**
   * Queue a task as a pending approval: the exact delegation input is
   * frozen at queue time and nothing executes until a human resolves
   * the pointer via POST /api/approvals. Email-kind approvals freeze a
   * mailbox payload instead of a run input.
   */
  private async queueSlackRun(input: { repoUrl?: unknown; task?: unknown; baseBranch?: unknown; publishPullRequest?: unknown; harness?: unknown; codingModel?: unknown; connectionId?: unknown; threadKey?: unknown; kind?: unknown; mailbox?: unknown; payload?: unknown; queuedBy?: unknown }): Promise<Response> {
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
    // The approver must see a real agent name on the card — validate here
    // so a bad harness fails before the card, never inside a container.
    const harness = typeof input.harness === "string" && input.harness.trim() ? input.harness.trim() : undefined;
    if (harness !== undefined) {
      try {
        resolveHarness(harness);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Unknown agent harness." }, { status: 400 });
      }
    }
    const publishPullRequest = input.publishPullRequest === true;
    if (publishPullRequest && !this.env.GITHUB_TOKEN) {
      return Response.json({ error: "publishPullRequest was requested but GITHUB_TOKEN is not configured." }, { status: 400 });
    }
    // Freeze the route at queue time (spec §4): the approval card shows the
    // exact harness/model/connection that will execute, and an inadmissible
    // selection is refused before any approval exists — no container starts.
    let route: ApprovedRoute | undefined;
    try {
      const resolved = await this.resolveRoute({
        repoUrl,
        task,
        baseBranch: typeof input.baseBranch === "string" ? input.baseBranch : "main",
        publishPullRequest,
        harness: typeof input.harness === "string" && input.harness.trim() ? (input.harness.trim() as DelegateInput["harness"]) : undefined,
        codingModel: typeof input.codingModel === "string" && input.codingModel.trim() ? input.codingModel.trim() : undefined,
        connectionId: typeof input.connectionId === "string" && input.connectionId.trim() ? input.connectionId.trim() : undefined,
      });
      route = resolved.route;
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Unsupported model route." }, { status: 400 });
    }
    const approvalId = crypto.randomUUID();
    const threadKey = typeof input.threadKey === "string" && input.threadKey.trim() ? input.threadKey.trim() : "default";
    // Flood guard: pending approvals persist in DO state — an uncapped queue
    // lets one trigger token crowd out Slack, chat, and dashboard intake.
    const MAX_PENDING = 100;
    if (this.approvals.filter((a) => a.status === "pending").length >= MAX_PENDING) {
      return Response.json({ error: "Approval queue is full — resolve pending approvals first." }, { status: 429 });
    }
    try {
      this.writeApprovals(createPendingApproval(this.approvals, {
        threadKey,
        approvalId,
        repoUrl,
        task: task.slice(0, 4000),
        baseBranch: typeof input.baseBranch === "string" && input.baseBranch.trim() ? input.baseBranch.slice(0, 200) : "main",
        publishPullRequest,
        route,
        // Worker-vouched principal (X-Agent-Principal) — never the raw body,
        // so an operator-queued record can't be claimed by an agent token.
        ...(typeof input.queuedBy === "string" && input.queuedBy.trim()
          ? { queuedBy: input.queuedBy.trim().slice(0, 200) }
          : {}),
        createdAt: Date.now(),
      }));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Could not queue approval." }, { status: 409 });
    }
    return Response.json({ ok: true, approvalId, repoUrl, task: task.slice(0, 4000), route: describeRoute(route) });
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
    // Address-format check fails at intake, not post-approval at the
    // binding — and the value freezes trimmed, so a padded address like
    // " user@x.com " can't slide through the check and hit the wire.
    if (kind === "email_send") {
      const toAddr = (fields.to_addr as string).trim();
      if (!ADDRESS_RE.test(toAddr)) {
        return Response.json({ error: "payload.to_addr must be a valid email address." }, { status: 400 });
      }
      fields.to_addr = toAddr;
    }
    // The same registration invariant the MCP path enforces via
    // requireMailbox: an approval's From must be a registered mailbox.
    const registration = await registeredMailbox(this.env, mailbox);
    if (registration === null) {
      return Response.json({ error: `mailbox is not registered: ${mailbox}` }, { status: 400 });
    }
    // Bind a draft-backed send to the row it names: the draft must
    // exist in this mailbox, sit `queued` (the CAS every legit mint
    // follows — MCP send_email and the dashboard both lock-then-mint),
    // and carry exactly the content the payload freezes. Without this a
    // caller could mint an approval on another approval's draft with
    // different content: the first-approved payload sends, and the
    // parasite dedupes `executed` on mail it never wrote.
    if (kind === "email_send") {
      const draftId = typeof fields.draft_id === "string" ? fields.draft_id.trim() : "";
      if (draftId !== "") {
        const draftRes = await mailboxStub(this.env, registration.address).fetch(
          new Request(`https://internal/internal/mailbox/drafts/${encodeURIComponent(draftId)}`),
        );
        const draftRow = draftRes.ok
          ? ((((await draftRes.json().catch(() => ({}))) as { draft?: Record<string, unknown> }).draft) ?? null)
          : null;
        if (draftRow === null) {
          return Response.json({ error: `payload.draft_id "${draftId}" was not found in ${registration.address}.` }, { status: 400 });
        }
        if (draftRow.status !== "queued") {
          return Response.json({ error: `draft "${draftId}" is "${String(draftRow.status)}" — only a queued draft can back an email_send approval.` }, { status: 400 });
        }
        if (
          draftRow.to_addr !== fields.to_addr ||
          draftRow.subject !== fields.subject ||
          draftRow.body_text !== fields.body_text
        ) {
          return Response.json({ error: `payload does not match draft "${draftId}" — a draft-backed send must freeze the draft's own content.` }, { status: 400 });
        }
      }
    }
    const approvalId = crypto.randomUUID();
    const threadKey = typeof input.threadKey === "string" && input.threadKey.trim() ? input.threadKey.trim() : "default";
    const subject = typeof fields.subject === "string" ? fields.subject : "";
    // The spec's card phrasing — "Agent X requests email send to Y:
    // subject" — reads verbatim off the card's "requests ${task}"
    // headline, so the action text lives on the record itself.
    const task = kind === "email_send"
      ? `email send to ${String(fields.to_addr)}: ${subject}`
      : `email delete of ${String(fields.email_id)}${subject ? ` "${subject}"` : ""}`;
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
    const body = kind === "email_send" ? String(fields.body_text).trim() : "";
    const excerpt = body.length > 500 ? `${body.slice(0, 499)}…` : body;
    this.postEmailApprovalCard({
      threadKey,
      approvalId,
      repoUrl: mailbox,
      // The card builder mrkdwn-escapes `task`, so the untrusted body excerpt is escaped with it.
      task: excerpt ? `${task}\n${excerpt}` : task,
      kind,
      ...(registration.agent ? { agent: registration.agent } : {}),
    });
    return Response.json({ ok: true, approvalId, kind, mailbox });
  }

  /**
   * Email approvals mint with no Slack thread context — there is no
   * thread_ts to post a card into. When the deployment configures an
   * approvals channel, the card posts there carrying the same pointer
   * buttons a thread card does, so a queued email approval is decidable
   * from Slack as well as the dashboard. Optional and best-effort:
   * unset, the dashboard Approvals surface is the only resolve path,
   * and a post failure never faults the mint.
   */
  private postEmailApprovalCard(input: ApprovalCardInput): void {
    const channel = this.env.SLACK_APPROVALS_CHANNEL?.trim();
    const token = this.env.SLACK_BOT_TOKEN?.trim();
    if (!channel || !token) return;
    const posted = fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, text: approvalCardText(input).slice(0, 3000), blocks: buildApprovalBlocks(input) }),
    }).then(async (response) => {
      // Slack reports app-level failures (not_in_channel, …) as HTTP 200 with ok:false.
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || body?.ok !== true) {
        console.error(`Slack email approval card post failed (${response.status}): ${body?.error ?? "unparseable response"}`);
      }
    }).catch((error) => {
      console.error("Slack email approval card post failed", redactSecrets(String(error)));
    });
    if (typeof this.ctx === "object" && this.ctx !== null && "waitUntil" in this.ctx) {
      this.ctx.waitUntil(posted);
    } else {
      void posted;
    }
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
      ? approvals.find((approval) => approval.approvalId === approvalId && approval.threadKey === threadKey)
      : undefined;
    const rejectedEmail =
      result.result === "rejected"
        ? approvals.find(
            (approval) =>
              approval.approvalId === approvalId &&
              approval.threadKey === threadKey &&
              approval.kind === "email_send",
          )
        : undefined;
    const isEmailRecord = record !== undefined && (record.kind === "email_send" || record.kind === "email_delete");
    const run = record && !isEmailRecord ? createRun({
      runId: `agent-tool:${approvalId}`,
      sandboxId: makeSandboxId(record.repoUrl, record.task, approvalId),
      repoUrl: record.repoUrl,
      task: record.task,
      baseBranch: record.baseBranch ?? "main",
      publishPullRequest: record.publishPullRequest ?? false,
      queuedBy: record.queuedBy,
      ...(record.route ? { route: record.route } : {}),
    }) : undefined;
    // One state write reserves capacity and records the decision before any await.
    this.setState({
      ...this.state,
      pendingApprovals: approvals,
      runs: run ? [...this.store.list(), run] : this.store.list(),
    });
    if (run) {
      const dispatch = async () => {
        const generation = this.store.get(run.runId)?.generation;
        try {
          const delegate = this.getTools()["delegate_coding_task"] as {
            execute: (input: unknown, options?: unknown) => Promise<unknown>;
          };
          await delegate.execute({
            repoUrl: run.repoUrl,
            task: run.task,
            baseBranch: run.baseBranch,
            publishPullRequest: run.publishPullRequest,
            // The frozen route is the exact approved input: harness, model,
            // and connection ride the pointer, never a fresh lookup. Pending
            // approvals queued before route freezing carry `harness` only —
            // pass it so the approved agent is not silently re-defaulted.
            ...(run.route
              ? {
                  harness: run.route.harness,
                  codingModel: run.route.modelId,
                  ...(run.route.connectionId ? { connectionId: run.route.connectionId } : {}),
                }
              : record?.harness
                ? { harness: record.harness as DelegateInput["harness"] }
                : {}),
          }, { toolCallId: approvalId });
        } catch (error) {
          // delegate.execute can throw before its inner `finish` seam ran;
          // this fallback is the terminal transition then. Fence on the
          // pre-dispatch generation so a terminal state that already landed
          // (cancel, reclaim, or `finish` itself) is never overwritten —
          // the dropped write means this catch also distills nothing.
          const failure = classifyRunError(error);
          const status = terminalStatusFor(failure.code);
          const updated = this.store.transition(run.runId, status, {
            error: redactSecrets(failure.message).slice(0, 4000),
            errorCode: failure.code,
          }, generation);
          if (updated !== null) {
            // A pre-start failure never reaches `finish`'s slackText seam —
            // post here or the thread sees ack + card + approved, then silence.
            this.postToThread(slackRunFailed({
              repoUrl: run.repoUrl,
              userMessage: runErrorWire(failure.code).userMessage,
              detail: redactSecrets(failure.message).slice(0, 1000),
              unknown: status === "unknown",
            }));
            if (status === "completed" || status === "error") {
              this.dispatchSessionDistill(updated);
            }
          }
        }
      };
      // Slack/dashboard approvals hold no socket open, so without the heartbeat the DO can idle out mid-run.
      this.keepAliveWhile(dispatch).catch((error) => {
        console.error(`Run ${run.runId} dispatch failed`, redactSecrets(String(error)));
      });
    }
    if (record && isEmailRecord) {
      this.dispatchApprovedEmail(record);
    }
    // Rejecting frees the queued draft back to `draft`, and expired
    // email approvals leave their queued drafts the same way — without
    // the compensating release the row strands `queued` behind an
    // approval that can never (re-)resolve. Records whose draft a still
    // live sibling pending approval also locks are skipped: intake
    // deliberately lets a second approval mint on an already-`queued`
    // row, and freeing it here would strand that sibling's later
    // approve at the claim CAS.
    const releasable = rejectedEmail === undefined ? expiredSends : [rejectedEmail, ...expiredSends];
    this.releaseEmailApprovalDrafts(releasable, this.liveApprovalDrafts(now));
    this.sweepStaleDrafts(expiredSends.length > 0);
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
        // Pre-claim failures run a stale-sweep on the mailbox — the sweep's
        // age check can't see sibling approvals minted after a row queued,
        // so live pending drafts ride along as exclusions.
        const ref = emailApprovalDraftRef(record);
        const live = ref === null ? undefined : this.liveApprovalDrafts(Date.now()).get(ref.mailbox);
        await executeEmailApproval(this.env, record, {
          excludeDraftIds: live === undefined ? undefined : [...live],
        });
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
        // PostTransmitError = the mail already left; `failed` here would
        // contradict the draft's `sent` mark and invite a re-approval
        // double-send, so the record reads `executed` with the
        // bookkeeping failure noted.
        const transmitted = error instanceof PostTransmitError;
        this.writeApprovals(recordApprovalExecution(this.approvals, {
          threadKey,
          approvalId,
          execution: transmitted
            ? { status: "executed", error: `transmitted — post-send record failed: ${message}`, executedAt: Date.now() }
            : { status: "failed", error: message, executedAt: Date.now() },
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

  /**
   * Megaplan T10: distill a retained terminal run's transcript into
   * long-term memory (Memory DO facts + a session row). Fired from the
   * fenced `finish` seam so a dropped transition distills nothing;
   * `ctx.waitUntil` keeps the DO alive through the model call and the
   * stub writes. Wrapped in try/catch and gated by `MEMORY_ENABLED`
   * inside distillSession — a failure logs and never fails the run.
   */
  private dispatchSessionDistill(run: DelegatedRun): void {
    const pending = (async () => {
      try {
        await distillSession(this.env, run, { agent: this.name });
      } catch (error) {
        console.error(`Session distillation failed for ${run.runId}`, redactSecrets(String(error)));
      }
    })();
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
    this.postToThread(slackRunCancelled({ repoUrl: run.repoUrl }));
    await this.destroySandbox(run.sandboxId);
    return updated;
  }

  /**
   * Chat post-back: thread-keyed orchestrators (`slack:{team}:{channel}:{ts}`,
   * `telegram:{chat}`, `discord:{channel}`) relay run start + terminal outcome
   * into the conversation they came from. Best-effort — the ack already went
   * out and failure must not touch the run.
   */
  private postToThread(text: string): void {
    const chat = postToChatThread(this.env, this.name, text);
    if (chat) {
      this.ctx.waitUntil(chat.catch((error: unknown) => {
        console.error("Chat post-back failed", redactSecrets(String(error)));
      }));
      return;
    }
    const ids = parseSlackThreadName(this.name);
    const token = this.env.SLACK_BOT_TOKEN?.trim();
    if (!ids || !token) return;
    this.ctx.waitUntil(
      postSlackMessage(token, { channel: ids.channelId, threadTs: ids.threadTs, text: text.slice(0, 3000) })
        .catch((error: unknown) => {
          console.error(`Slack post-back failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        }),
    );
  }

  /** Terminal "unknown" notice for runs that end outside `finish` (restart, reclaim). */
  private postOutcomeUnknown(run: DelegatedRun): void {
    this.postToThread(slackRunFailed({
      repoUrl: run.repoUrl,
      userMessage: runErrorWire(run.errorCode ?? "outcome_unknown").userMessage,
      detail: run.error?.slice(0, 1000),
      unknown: true,
    }));
  }

  /** Wire projection for API responses: errorCode -> {status, code, userMessage}. */
  private serializeRun(run: DelegatedRun): DelegatedRun & { errorWire?: RunErrorWire } {
    return run.errorCode ? { ...run, errorWire: runErrorWire(run.errorCode) } : run;
  }

  private leakPersistenceArmed = false;
  /** Mirror the per-isolate leak registry into DO state so hibernation
   * can't strand a failed destroy — the sink is registered lazily because
   * subclasses in tests may skip the base constructor. */
  private armLeakPersistence(): void {
    if (this.leakPersistenceArmed) return;
    this.leakPersistenceArmed = true;
    setLeakPersistence(
      (leak) =>
        this.setState({
          ...this.state,
          leakedContainers: { ...this.state?.leakedContainers, [leak.sandboxId]: leak },
        }),
      (sandboxId) => {
        if (this.state?.leakedContainers?.[sandboxId] === undefined) return;
        const next = { ...this.state.leakedContainers };
        delete next[sandboxId];
        this.setState({ ...this.state, leakedContainers: next });
      },
    );
  }

  private async destroySandbox(sandboxId: string): Promise<void> {
    // Release goes through the scoped lifecycle: failures are tracked as
    // leaked containers (warn + registry) instead of only logged.
    this.armLeakPersistence();
    await destroyManagedContainer(this.env, sandboxId);
  }

  /** Public: also the `schedule()` callback armed when a run starts. */
  async reclaimRuns(): Promise<void> {
    this.armLeakPersistence();
    const { runs, reclaimed } = reclaimStaleRuns(this.store.list(), Date.now());
    if (reclaimed.length > 0) {
      this.setState({ ...this.state, runs });
      await Promise.all(runs.filter((run) => reclaimed.includes(run.runId)).map(async (run) => {
        this.postOutcomeUnknown(run);
        this.runControllers.get(run.runId)?.abort();
        await this.destroySandbox(run.sandboxId);
      }));
    }
    // Leaked containers outlive the run that leaked them: retry destroy on
    // every reclaim pass; a successful destroy clears its own registry entry.
    // Durable entries from before a hibernation union with this isolate's.
    const leaks = new Map<string, { sandboxId: string; leakedAt: number; error: string }>(
      Object.values(this.state?.leakedContainers ?? {}).map((leak) => [leak.sandboxId, leak]),
    );
    for (const leak of leakedContainers()) leaks.set(leak.sandboxId, leak);
    await Promise.all([...leaks.values()].map((leak) => this.destroySandbox(leak.sandboxId)));
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
   * Draft rows still owned by a resolvable email approval, keyed by
   * mailbox — pending, unexpired email_send records only: an expired
   * pointer can never resolve, so it must not hold the lock it once
   * took, and decided records are already compensated by the release
   * path. Intake mints sibling approvals on an already-`queued` row
   * (same draft, same content), so every release path consults this
   * set before freeing — dropping the lock while a sibling is pending
   * strands its later approve at the claim CAS.
   */
  private liveApprovalDrafts(now: number): Map<string, Set<string>> {
    const live = new Map<string, Set<string>>();
    for (const approval of this.approvals) {
      if (approval.status !== "pending" || approval.kind !== "email_send" || isApprovalExpired(approval, now)) {
        continue;
      }
      const ref = emailApprovalDraftRef(approval);
      if (ref === null) continue;
      const ids = live.get(ref.mailbox) ?? new Set<string>();
      ids.add(ref.draftId);
      live.set(ref.mailbox, ids);
    }
    return live;
  }

  /**
   * Release each record's queued draft through the same unqueue seam a
   * rejection uses. `queued` rows are immutable to every other surface
   * (`updateDraft`/`markDraftQueued` refuse non-`draft` rows), so a
   * draft locked behind an approval that can no longer resolve is
   * stranded forever without this. `liveDrafts` names rows a still
   * resolvable sibling approval also locks — those stay `queued` for
   * the sibling to claim. Best-effort: a failure is logged, never
   * fatal to the pointer path that triggered it.
   */
  private releaseEmailApprovalDrafts(records: PendingApproval[], liveDrafts: Map<string, Set<string>>): void {
    const released = new Set<string>();
    const releasable = records.filter((record) => {
      const ref = emailApprovalDraftRef(record);
      if (ref === null) return false;
      const key = `${ref.mailbox}\0${ref.draftId}`;
      if (released.has(key)) return false;
      released.add(key);
      return liveDrafts.get(ref.mailbox)?.has(ref.draftId) !== true;
    });
    if (releasable.length === 0) return;
    const releases = Promise.all(
      releasable.map((record) =>
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
   * Backstop for the single-shot releases above: a draft left `queued`
   * or `sending` past its provable lifetime (the approval TTL, a live
   * send's seconds) belongs to a decision whose compensating release
   * failed or never ran — including records a prune dropped or a mint
   * that never wrote. Sweeps every registered mailbox through the
   * `/drafts/release-stale` seam, which frees only provably-dead rows,
   * so it can never unlock a live lock. Best-effort per mailbox, never
   * fatal to its trigger.
   *
   * Cadence-bounded by {@link STALE_SWEEP_INTERVAL_MS}: the approvals
   * poll fires every 10s and each run would otherwise wake every
   * registered mailbox ~4×/min. `force` bypasses the floor for the one
   * case that cannot wait — a touch that just dropped expired sends
   * (or a DO restart, where the floor starts at zero anyway).
   */
  private sweepStaleDrafts(force = false): void {
    const now = Date.now();
    if (!force && now - (this.lastStaleSweepAt ?? 0) < STALE_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastStaleSweepAt = now;
    // Captured synchronously, before the async sweep: rows a live
    // pending approval still owns are named to the mailbox as
    // `exclude_ids` so the backstop frees only provably-dead locks and
    // can never strand a sibling approval minted on an already-`queued`
    // row. No body when the set is empty — the legacy wire shape.
    const liveDrafts = this.liveApprovalDrafts(now);
    const sweep = (async () => {
      const listing = await mailboxDirectoryStub(this.env).fetch(
        new Request("https://internal/internal/mailbox/mailboxes"),
      );
      if (!listing.ok) {
        console.error(`Stale draft sweep: mailbox directory list failed (${listing.status})`);
        return;
      }
      const { mailboxes } = (await listing.json()) as { mailboxes?: MailboxRecord[] };
      await Promise.all(
        (mailboxes ?? []).map(async (record) => {
          const exclude = liveDrafts.get(record.address.toLowerCase());
          try {
            const swept = await mailboxStub(this.env, record.address).fetch(
              new Request("https://internal/internal/mailbox/drafts/release-stale", {
                method: "POST",
                ...(exclude !== undefined && exclude.size > 0
                  ? {
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ exclude_ids: [...exclude] }),
                    }
                  : {}),
              }),
            );
            if (!swept.ok) {
              console.warn(`Stale draft sweep failed for ${record.address} (${swept.status})`);
            }
          } catch (error) {
            console.warn(`Stale draft sweep failed for ${record.address}`, redactSecrets(String(error)));
          }
        }),
      );
    })().catch((error) => {
      console.error("Stale draft sweep failed", redactSecrets(String(error)));
    });
    if (typeof this.ctx === "object" && this.ctx !== null && "waitUntil" in this.ctx) {
      this.ctx.waitUntil(sweep);
    } else {
      void sweep;
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
  private listApprovals(agentPrincipal: string | null): Response {
    const now = Date.now();
    const expiredSends = this.expiredEmailSends(now);
    const pruned = pruneExpiredApprovals(this.approvals, now);
    if (pruned.length !== this.approvals.length) {
      this.writeApprovals(pruned);
      this.releaseEmailApprovalDrafts(expiredSends, this.liveApprovalDrafts(now));
    }
    this.sweepStaleDrafts(expiredSends.length > 0);
    // Agent principals see only records they queued; operator surfaces
    // (no principal header) keep the full listing.
    const visible = agentPrincipal === null
      ? pruned
      : pruned.filter((approval) => approval.queuedBy === agentPrincipal);
    return Response.json({
      approvals: visible.filter((approval) => approval.status === "pending"),
      // Decided records leave the pending arm but stay listed — the
      // execution stamp (including a failed send) is durable state no
      // other surface renders, so the listing returns recent ones.
      decided: decidedApprovals(visible),
    });
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Worker-vouched agent identity: only mcp-run-tools sets this after
    // bearer auth, so it scopes reads/cancels to records that principal
    // queued. External callers never reach this DO without an Access or
    // signature-authenticated identity on the Worker first.
    const agentPrincipal = request.headers.get(AGENT_PRINCIPAL_HEADER)?.trim() || null;
    // Cron backstop for the poll-driven stale-draft sweep — in a quiet
    // system no approvals fetch or DO restart ever calls it, so a human
    // who stops polling would leave `sending`-locked drafts held forever.
    if (request.method === "POST" && url.pathname === "/internal/sweep-drafts") {
      this.sweepStaleDrafts(true);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/approvals" && request.method === "GET") {
      return this.listApprovals(agentPrincipal);
    }
    if (request.method === "POST" && url.pathname === "/api/approvals") {
      // Approving is a human act — an agent principal can never decide.
      if (agentPrincipal !== null) {
        return Response.json({ error: "Agent principals cannot decide approvals." }, { status: 403 });
      }
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
      // queuedBy comes only from the vouched header — a body field would
      // let any caller attribute its run to another principal.
      return this.queueSlackRun({ ...(queueBody as Record<string, unknown>), queuedBy: agentPrincipal ?? undefined });
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
      const visible = agentPrincipal === null
        ? this.store.list()
        : this.store.list().filter((run) => run.queuedBy === agentPrincipal);
      const limitParam = url.searchParams.get("limit");
      if (limitParam !== null) {
        const limit = Number(limitParam);
        if (!Number.isInteger(limit) || limit < 1) {
          return Response.json({ error: "limit must be a positive integer." }, { status: 400 });
        }
        // Store order is oldest-first; a bounded listing serves newest first.
        return Response.json({ runs: visible.slice(-Math.min(limit, 500)).reverse().map((run) => this.serializeRun(run)) });
      }
      return Response.json({ runs: visible.map((run) => this.serializeRun(run)) });
    }
    if (request.method === "DELETE" && id === null) {
      // Registry clear is an operator action — never agent-bulk-deletable.
      if (agentPrincipal !== null) {
        return Response.json({ error: "Agent principals cannot clear the run registry." }, { status: 403 });
      }
      await this.clearRuns();
      return Response.json({ ok: true });
    }
    if (id !== null && request.method === "GET") {
      const run = this.store.get(id);
      return run && (agentPrincipal === null || run.queuedBy === agentPrincipal)
        ? Response.json({ run: this.serializeRun(run) })
        : Response.json({ error: "Run not found." }, { status: 404 });
    }
    if (id !== null && request.method === "DELETE") {
      const existing = this.store.get(id);
      if (!existing || (agentPrincipal !== null && existing.queuedBy !== agentPrincipal)) {
        return Response.json({ error: "Run not found." }, { status: 404 });
      }
      const run = await this.cancelRun(id);
      return run
        ? Response.json({ run: this.serializeRun(run) })
        : Response.json({ error: "Run not found." }, { status: 404 });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
}
