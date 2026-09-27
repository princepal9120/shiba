/**
 * Durable run registry wire types — shared between the orchestrator's DO
 * state, the Worker API routes that serve them, and the dashboard. A run
 * is an append-only receipt log: completed/error/cancelled/aborted are
 * terminal, and there is no stop/resume.
 */
import type { ApprovedRoute } from "./model.js";
import type { Receipt } from "./receipts.js";
import type { RunErrorCode } from "./run-errors.js";
import type { SteeringNote } from "./steering.js";

/**
 * Worker-vouched agent identity for run/approval reads: only the MCP
 * gateway's run tools set this after bearer-token auth. When present,
 * /api/runs and /api/approvals reads scope to records that principal
 * queued — operator surfaces never send it and keep the full listing.
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
  /** Sandbox preview URL captured at run end (T33); null when capture failed or was skipped. */
  previewUrl?: string | null;
  /** Absolute URL serving the stored preview PNG on this Worker (T33); null when capture failed. */
  screenshotUrl?: string | null;
  receipts?: Receipt[];
  /**
   * MCP principal that queued this run (X-Agent-Principal at intake).
   * Absent on operator-queued runs (dashboard/Slack/automation) — agent
   * tokens only ever see their own runs through the run tools.
   */
  queuedBy?: string;
  /**
   * The frozen, approval-gated route (connection/model/harness ids only).
   * Absent on runs that predate route freezing. Never carries credentials.
   */
  route?: ApprovedRoute;
  /**
   * T31 mid-run steering notes, oldest-first and bounded (see steering.ts).
   * Escalations point at the pending approval a steer minted after
   * cancelling the live run. Absent on runs that predate steering.
   */
  steering?: SteeringNote[];
}

export type RunPatch = {
  summary?: string;
  error?: string;
  errorCode?: RunErrorCode;
  diff?: string;
  pullUrl?: string;
  previewUrl?: string | null;
  screenshotUrl?: string | null;
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

export function countActiveRuns(runs: DelegatedRun[]): number {
  return runs.filter((run) => isActiveStatus(run.status)).length;
}

// Reclaim runs orphaned by eviction so they cannot hold slots indefinitely.
// Above the sum of per-phase timeouts (clone 5m + harness 15m + git 5m) so a
// healthy worst-case run is never reaped; eviction is the only orphan source.
export const RUN_DEADLINE_MS = 45 * 60 * 1000;

export function canStartRun(runs: DelegatedRun[]): boolean {
  return countActiveRuns(runs) < MAX_CONCURRENT_RUNS;
}
