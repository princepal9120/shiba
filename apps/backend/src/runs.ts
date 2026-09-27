/**
 * Durable run registry helpers. The orchestrator keeps these records in
 * Durable Object state; the Worker gates drill-in routes on them.
 *
 * Cloudbox-style: a run is an append-only receipt log. Runs are one-shot:
 * completed/error/cancelled/aborted are terminal, and there is no
 * stop/resume — resumable runs are a real architecture change and were
 * deliberately cut (PLAN.md §4, "Future work").
 *
 * T40: transition legality now lives in the pure decider
 * (`decideRunTransition` in @shiba/shared); these functions are the thin
 * wrappers that keep existing call sites stable. The decider refuses what
 * the old patch API silently allowed: no `running` without approval
 * evidence on the run, no `completed` from `pending`, no rewrites of a
 * terminal record.
 */
import {
  applyRunEvents,
  decideRunTransition,
  isActiveStatus,
  normalizeRun,
  RUN_DEADLINE_MS,
} from "@shiba/shared";
import type {
  ApprovalEvidence,
  ApprovedRoute,
  DelegatedRun,
  Receipt,
  RunCommand,
  RunPatch,
  RunStatus,
} from "@shiba/shared";
import { appendReceipt, makeReceipt } from "./receipts.js";

// Wire types and pure predicates live in @shiba/shared so the dashboard
// consumes the same record shape; re-exported here for existing imports.
export {
  AGENT_PRINCIPAL_HEADER,
  canStartRun,
  countActiveRuns,
  isActiveStatus,
  isTerminalStatus,
  MAX_CONCURRENT_RUNS,
  normalizeRun,
  RUN_DEADLINE_MS,
} from "@shiba/shared";
export type { DelegatedRun, RunPatch, RunStatus } from "@shiba/shared";

export function createRun(args: {
  runId: string;
  sandboxId: string;
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  queuedBy?: string;
  route?: ApprovedRoute;
  /** T40: approval evidence stamped at queue time (the resolve path). */
  approval?: ApprovalEvidence;
  now?: number;
}): DelegatedRun {
  const now = args.now ?? Date.now();
  const decision = decideRunTransition(
    { run: null },
    {
      type: "queue",
      commandId: `queue:${args.runId}`,
      runId: args.runId,
      input: {
        sandboxId: args.sandboxId,
        repoUrl: args.repoUrl,
        task: args.task,
        baseBranch: args.baseBranch,
        publishPullRequest: args.publishPullRequest,
        ...(args.queuedBy !== undefined ? { queuedBy: args.queuedBy } : {}),
        ...(args.route !== undefined ? { route: args.route } : {}),
      },
      ...(args.approval !== undefined ? { approval: args.approval } : {}),
      at: now,
    },
  );
  // Queue on an empty machine can only fail on a mismatched evidence hash —
  // a wiring bug, so it throws rather than silently returning a half-record.
  if ("error" in decision) throw new Error(decision.error.message);
  const run = applyRunEvents(null, decision.events, makeReceipt);
  if (run === null) throw new Error(`decider produced no record for ${args.runId}`);
  return run;
}

/**
 * Map the legacy (run, status, patch) call shape onto the command the
 * decider understands.
 */
function commandForStatus(
  run: DelegatedRun,
  status: RunStatus,
  patch: RunPatch | undefined,
  at: number,
  evidence?: ApprovalEvidence,
): RunCommand {
  const commandId = `transition:${run.runId}:${run.generation}:${status}`;
  switch (status) {
    case "pending":
      // Re-queue with the run's own input: on a live run the decider
      // replays it as a no-op; it refuses (input_conflict) only if the
      // stored fields were corrupted out from under the record.
      return {
        type: "queue",
        commandId,
        runId: run.runId,
        input: {
          sandboxId: run.sandboxId,
          repoUrl: run.repoUrl,
          task: run.task,
          baseBranch: run.baseBranch,
          publishPullRequest: run.publishPullRequest,
          ...(run.queuedBy !== undefined ? { queuedBy: run.queuedBy } : {}),
          ...(run.route !== undefined ? { route: run.route } : {}),
        },
        at,
      };
    case "running":
      return {
        type: "start",
        commandId,
        runId: run.runId,
        // An unevidenced start is rejected inside the decider; stored
        // evidence on the run itself satisfies it when the caller has none.
        ...(evidence !== undefined ? { approvalEvidence: evidence } : {}),
        at,
      };
    case "completed":
      return { type: "finish", commandId, runId: run.runId, patch: patch ?? {}, at };
    case "cancelled":
      return { type: "cancel", commandId, runId: run.runId, ...(patch !== undefined ? { patch } : {}), at };
    case "aborted":
      return {
        type: "abort",
        commandId,
        runId: run.runId,
        reason: patch?.error ?? "aborted",
        ...(patch !== undefined ? { patch } : {}),
        at,
      };
    case "unknown":
      return {
        type: "fail",
        commandId,
        runId: run.runId,
        patch: { ...patch, errorCode: patch?.errorCode ?? "outcome_unknown" },
        at,
      };
    case "error":
    default:
      return {
        type: "fail",
        commandId,
        runId: run.runId,
        patch: { ...patch, errorCode: patch?.errorCode ?? "executor_failed" },
        at,
      };
  }
}

export function transitionRun(
  run: DelegatedRun,
  status: RunStatus,
  patch?: RunPatch,
  now?: number,
  evidence?: ApprovalEvidence,
): DelegatedRun {
  const stamped = now ?? Date.now();
  const decision = decideRunTransition(
    { run },
    commandForStatus(run, status, patch, stamped, evidence),
  );
  // Preserve the pre-decider contract: an illegal or terminal transition
  // returns the record unchanged — callers fence on generation for drops.
  if ("error" in decision) return run;
  return applyRunEvents(run, decision.events, makeReceipt) ?? run;
}

export function recordReceipt(run: DelegatedRun, receipt: Receipt): DelegatedRun {
  return { ...run, receipts: appendReceipt(run.receipts, receipt), updatedAt: receipt.at };
}

// Terminal records stay immutable even when a child finishes after reclamation.
export function reclaimStaleRuns(
  runs: DelegatedRun[],
  now: number,
  deadlineMs: number = RUN_DEADLINE_MS,
): { runs: DelegatedRun[]; reclaimed: string[] } {
  const reclaimed: string[] = [];
  const next = runs.map((run) => {
    if (!isActiveStatus(run.status) || now - run.updatedAt <= deadlineMs) {
      return run;
    }
    const decision = decideRunTransition(
      { run },
      {
        type: "reclaim",
        commandId: `reclaim:${run.runId}:${run.generation}`,
        runId: run.runId,
        deadlineMs,
        at: now,
      },
    );
    if ("error" in decision) return run;
    reclaimed.push(run.runId);
    return applyRunEvents(run, decision.events, makeReceipt) ?? run;
  });
  return { runs: next, reclaimed };
}

/**
 * Owns the find/map/replace pattern against the retained run list so callers
 * (orchestrator transitions, the run-detail route) don't each re-derive it.
 * State storage itself stays injected — the store doesn't know it's a
 * Durable Object.
 */
export class RunStore {
  constructor(
    private readonly read: () => DelegatedRun[],
    private readonly write: (runs: DelegatedRun[]) => void,
  ) {}

  list(): DelegatedRun[] {
    return this.read().map(normalizeRun);
  }

  get(runId: string): DelegatedRun | null {
    const run = this.read().find((run) => run.runId === runId);
    return run ? normalizeRun(run) : null;
  }

  add(run: DelegatedRun): void {
    this.write([...this.read(), run]);
  }

  /**
   * A provided expectedGeneration fences the write: a mismatch means the
   * writer's snapshot is stale (cancel/reclaim landed in between) and the
   * transition is dropped silently — nothing is written, null is returned.
   */
  transition(
    runId: string,
    status: RunStatus,
    patch?: RunPatch,
    expectedGeneration?: number,
    evidence?: ApprovalEvidence,
  ): DelegatedRun | null {
    const runs = this.read().map(normalizeRun);
    const current = runs.find((run) => run.runId === runId);
    if (!current) return null;
    if (expectedGeneration !== undefined && current.generation !== expectedGeneration) {
      return null;
    }
    let updated: DelegatedRun | null = null;
    this.write(
      runs.map((run) => {
        if (run.runId !== runId) return run;
        updated = transitionRun(run, status, patch, undefined, evidence);
        return updated;
      }),
    );
    return updated;
  }

  replace(runId: string, next: DelegatedRun): void {
    this.write(this.read().map((run) => (run.runId === runId ? next : normalizeRun(run))));
  }

  clear(): void {
    this.write([]);
  }
}
