/**
 * Durable run registry helpers. The orchestrator keeps these records in
 * Durable Object state; the Worker gates drill-in routes on them.
 *
 * Cloudbox-style: a run is an append-only receipt log. Runs are one-shot:
 * completed/error/cancelled/aborted are terminal, and there is no
 * stop/resume — resumable runs are a real architecture change and were
 * deliberately cut (PLAN.md §4, "Future work").
 */
import type { ApprovedRoute } from "./model-connections.js";
import { appendReceipt, makeReceipt, type Receipt } from "./receipts.js";
import type { RunErrorCode } from "./run-errors.js";

/**
 * Worker-vouched agent identity for run/approval reads: only the MCP
 * gateway's run tools set this after bearer-token auth. When present,
 * /api/runs and /api/approvals reads scope to records that principal
 * queued — operator surfaces never send it and keep the full listing.
 * Lives here (not the orchestrator) so mcp-run-tools can import it
 * without pulling the agent runtime into the MCP gateway.
 */
export const AGENT_PRINCIPAL_HEADER = "X-Agent-Principal";

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "cancelled"
  | "unknown";

export interface DelegatedRun {
  runId: string;
  sandboxId: string;
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  /**
   * Fencing token: 0 at creation, bumped by every successful transition.
   * A writer carrying a stale expectedGeneration is dropped — a late child
   * result after cancel/reclaim cannot overwrite terminal state.
   */
  generation: number;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  error?: string;
  /** Classified error code; set on every error/unknown transition. */
  errorCode?: RunErrorCode;
  diff?: string;
  /** Published PR, kept apart from `summary` where a long diff would truncate it away. */
  pullUrl?: string;
  receipts?: Receipt[];
  /**
   * MCP principal that queued this run (X-Agent-Principal at intake).
   * Absent on operator-queued runs (dashboard/Slack/automation) — agent
   * tokens only ever see their own runs through the run tools.
   */
  queuedBy?: string;
  /**
   * The frozen, approval-gated route (connection/model/harness ids only —
   * spec MODEL-CONNECTIONS-ARCHITECTURE.md §4). Absent on runs that
   * predate route freezing. Never carries credentials.
   */
  route?: ApprovedRoute;
}

export type RunPatch = {
  summary?: string;
  error?: string;
  errorCode?: RunErrorCode;
  diff?: string;
  pullUrl?: string;
  receipts?: Receipt[];
  sandboxId?: string;
};

/** Backfills fields persisted runs predate; never rejects a legacy record. */
export function normalizeRun(run: DelegatedRun): DelegatedRun {
  if (typeof run.generation === "number" && !Number.isNaN(run.generation)) return run;
  return { ...run, generation: 0 };
}

/**
 * Maximum concurrent coding agents. Must match `max_instances` in
 * wrangler.jsonc; this is policy, not a platform limit (Cloudflare's own
 * default is 20). Parallel runs cost no more — billing is container-seconds.
 */
export const MAX_CONCURRENT_RUNS = 5;

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

export function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "error" ||
    status === "aborted" ||
    status === "cancelled" ||
    status === "unknown"
  );
}

export function isActiveStatus(status: RunStatus): boolean {
  return status === "pending" || status === "running";
}

function applyPatch(run: DelegatedRun, patch: RunPatch | undefined): DelegatedRun {
  if (!patch) return run;
  const next: DelegatedRun = { ...run };
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (patch.error !== undefined) next.error = patch.error;
  if (patch.errorCode !== undefined) next.errorCode = patch.errorCode;
  if (patch.diff !== undefined) next.diff = patch.diff;
  if (patch.pullUrl !== undefined) next.pullUrl = patch.pullUrl;
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

export function countActiveRuns(runs: DelegatedRun[]): number {
  return runs.filter((run) => isActiveStatus(run.status)).length;
}

// Reclaim runs orphaned by eviction so they cannot hold slots indefinitely.
// Above the sum of per-phase timeouts (clone 5m + harness 15m + git 5m) so a
// healthy worst-case run is never reaped; eviction is the only orphan source.
export const RUN_DEADLINE_MS = 45 * 60 * 1000;

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

export function canStartRun(runs: DelegatedRun[]): boolean {
  return countActiveRuns(runs) < MAX_CONCURRENT_RUNS;
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
