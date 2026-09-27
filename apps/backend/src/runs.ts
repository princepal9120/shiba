/**
 * Durable run registry helpers. The orchestrator keeps these records in
 * Durable Object state; the Worker gates drill-in routes on them.
 *
 * Cloudbox-style: a run is an append-only receipt log. Runs are one-shot:
 * completed/error/cancelled/aborted are terminal, and there is no
 * stop/resume — resumable runs are a real architecture change and were
 * deliberately cut (PLAN.md §4, "Future work").
 */
import {
  isActiveStatus,
  isTerminalStatus,
  normalizeRun,
  RUN_DEADLINE_MS,
} from "@shiba/shared";
import type { ApprovedRoute, DelegatedRun, Receipt, RunPatch, RunStatus } from "@shiba/shared";
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
  now?: number;
}): DelegatedRun {
  const now = args.now ?? Date.now();
  return {
    runId: args.runId,
    sandboxId: args.sandboxId,
    repoUrl: args.repoUrl,
    task: args.task,
    baseBranch: args.baseBranch,
    publishPullRequest: args.publishPullRequest,
    ...(args.queuedBy !== undefined ? { queuedBy: args.queuedBy } : {}),
    ...(args.route !== undefined ? { route: args.route } : {}),
    status: "pending",
    generation: 0,
    createdAt: now,
    updatedAt: now,
    receipts: [makeReceipt("init", `Queued ${args.repoUrl} (${args.baseBranch}).`, now)],
  };
}

function applyPatch(run: DelegatedRun, patch: RunPatch | undefined): DelegatedRun {
  if (!patch) return run;
  const next: DelegatedRun = { ...run };
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (patch.error !== undefined) next.error = patch.error;
  if (patch.errorCode !== undefined) next.errorCode = patch.errorCode;
  if (patch.diff !== undefined) next.diff = patch.diff;
  if (patch.pullUrl !== undefined) next.pullUrl = patch.pullUrl;
  if (patch.previewUrl !== undefined) next.previewUrl = patch.previewUrl;
  if (patch.screenshotUrl !== undefined) next.screenshotUrl = patch.screenshotUrl;
  if (patch.receipts !== undefined) next.receipts = patch.receipts;
  if (patch.sandboxId !== undefined) next.sandboxId = patch.sandboxId;
  return next;
}

export function transitionRun(
  run: DelegatedRun,
  status: RunStatus,
  patch?: RunPatch,
  now?: number,
): DelegatedRun {
  if (isTerminalStatus(run.status)) return run;
  const stamped = now ?? Date.now();
  const next = applyPatch(run, patch);
  const kind =
    status === "error" || status === "aborted" || status === "unknown"
      ? "error"
      : status === "completed"
        ? "submit"
        : undefined;
  const receipts = kind
    ? appendReceipt(next.receipts, makeReceipt(kind, patch?.error ?? patch?.summary ?? status, stamped))
    : next.receipts;
  return {
    ...next,
    status,
    generation: next.generation + 1,
    receipts,
    updatedAt: stamped,
  };
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
    reclaimed.push(run.runId);
    return transitionRun(
      run,
      "unknown",
      {
        error: `Run exceeded its ${Math.round(deadlineMs / 60000)}-minute deadline and was reclaimed; side effects are unverified — it may have pushed or opened a PR.`,
        errorCode: "outcome_unknown",
      },
      now,
    );
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
        updated = transitionRun(run, status, patch);
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
