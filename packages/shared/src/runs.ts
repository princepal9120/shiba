/**
 * Durable run registry wire types — shared between the orchestrator's DO
 * state, the Worker API routes that serve them, and the dashboard. A run
 * is an append-only receipt log: completed/error/cancelled/aborted are
 * terminal. A restart may re-dispatch a run whose checkpoint is still
 * `queued` or `dispatching` (no sandbox side effects yet). Once the
 * checkpoint is `executing` or `settling`, the outcome is unknown.
 */
import type { ApprovalEvidence } from "./approvals.js";
import type { RuntimeSelection } from "./local-runtime.js";
import type { ApprovedRoute } from "./model.js";
import type { Receipt } from "./receipts.js";
import type { RunErrorCode } from "./run-errors.js";
import type { RunSignal } from "./run-signals.js";
import type { SteeringNote } from "./steering.js";
import type { SubagentSandboxMode } from "./subagent.js";

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
  /** Frozen at approval. When true, a completed PR chains a read-only reviewer without a second card. */
  reviewAfterPublish?: boolean;
  /** Set on the reviewer run: the coding run this review covers. */
  reviewOf?: string;
  /** Latest review round id, stamped after the round is queued. */
  reviewRoundId?: string;
  /**
   * Fencing token: 0 at creation, bumped by every successful transition.
   * A writer carrying a stale expectedGeneration is dropped — a late child
   * result after cancel/reclaim cannot overwrite terminal state.
   */
  generation: number;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  /** Operator-archived timestamp; archiving leaves status intact. Absent on older records. */
  archivedAt?: number;
  summary?: string;
  error?: string;
  /** Classified error code; set on every error/unknown transition. */
  errorCode?: RunErrorCode;
  diff?: string;
  /** Published PR, kept apart from `summary` where a long diff would truncate it away. */
  pullUrl?: string;
  /** Absolute URL serving the stored preview PNG on this Worker (T33); null when capture failed. */
  screenshotUrl?: string | null;
  /** Phase 3: manifest URL for browser E2E frame evidence in R2. */
  browserE2eManifestUrl?: string | null;
  receipts?: Receipt[];
  /**
   * MCP principal that queued this run (X-Agent-Principal at intake).
   * Absent on operator-queued runs (dashboard/Slack/automation) — agent
   * tokens only ever see their own runs through the run tools.
   */
  queuedBy?: string;
  orgId?: string;
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
  /**
   * T40: the approval that authorized this run — who approved, when, and
   * the hash of the frozen input they approved. The decider refuses `start`
   * without it; absent on records predating the decider.
   */
  approval?: ApprovalEvidence;
  /**
   * T42: typed pipeline milestones the child emitted in order
   * (sandbox.ready → … → pr.opened/screenshot.captured), persisted on the
   * row so a waiter reads the signal it needs. Partial on a failed run —
   * the missing signals name the phase that never completed.
   */
  signals?: RunSignal[];
  /**
   * T48: the harness's continuation identity — e.g. `claude:home:<dir>` —
   * naming which conversation home this run belongs to. A run claiming to
   * continue a conversation is refused at queue when its key differs from
   * the conversation's key (decider-enforced, not UI). Absent for harnesses
   * without account-scoped homes.
   */
  continuationKey?: string;
  /**
   * T48: the subscription account this run ran under — an account NAME,
   * never a credential. Dispatch rebuilds the child input from it.
   */
  authAccount?: string;
  /**
   * T51: the approved runtime — `"local"` dispatches through the
   * LocalDispatch mailbox to the operator's daemon; absent = sandbox.
   */
  runtime?: RuntimeSelection;
  /** T51: the only machine whose daemon may claim this local run; approval-hashed. */
  targetMachineId?: string;
  /** The test command this approval-gated run executes, as argv. */
  testCommand?: string[];
  /**
   * Run-fork lineage (PLAN-V2-NEXT): the parent run and the checkpoint ref
   * this run resumes from (`refs/shiba/checkpoints/<sandboxId>/<seq>`).
   * Frozen at queue time and covered by the approval input hash like every
   * other approved field. Absent on runs that were not forked.
   */
  forkedFrom?: ForkLineage;
  /**
   * Token/cost usage the harness's event stream actually reported — never
   * fabricated. Absent when the harness emits no parseable usage (devin,
   * grok, cursor, antigravity, the local daemon) or the run died before a
   * usage event. `inputTokens` counts every input-side token the CLI
   * reported, including prompt-cache reads and writes; `outputTokens`
   * includes reasoning tokens. `costUsd` is present only when the CLI
   * prices the run itself.
   */
  usage?: RunUsage;
  /** Phase 2b: parent run when this row is a subagent child. */
  parentRunId?: string;
  /** Phase 2b: dotted tree path (see subagent.ts). */
  subagentPath?: string;
  /** Phase 2b: fresh container vs shared parent sandbox. */
  subagentSandbox?: SubagentSandboxMode;
  /**
   * Phase 2b: remaining subagent spawns covered by the root approval
   * (decremented on each budgeted spawn). Absent = per-spawn approval.
   */
  subagentBudgetRemaining?: number;
  /** Phase 2b: den DO name when spawned under a den (pack coordinator) instance. */
  denId?: string;
  /** @deprecated Use denId — still accepted on intake and echoed on API responses. */
  captainId?: string;
  /** T52 / dispatch: role pin frozen on the run row when set at queue time. */
  role?: import("./roles.js").AgentRole;
  /** Sandbox provider id for this run (task override frozen at queue time). */
  sandboxProvider?: string;
  customAgentId?: string;
  /** T68: env names + digest (approval-hashed); values only inside `envSealed`. */
  envNames?: string[];
  envDigest?: string;
  envSealed?: string;
  /** T72: approval-hashed opt-in to the repo's setup script. */
  runSetup?: boolean;
  /**
   * Durable phase written before the next await. A Worker/DO restart
   * resumes `queued` and `dispatching` runs that have not touched a
   * sandbox, and marks `executing` / `settling` runs unknown.
   */
  checkpoint?: "queued" | "dispatching" | "executing" | "settling" | "terminal";
  /** Set when a restart already re-dispatched this run. A second restart will not. */
  resumeAttemptedAt?: number;
}

/**
 * Lineage a forked run carries: which parent run it cloned from and the
 * git checkpoint ref (in the parent's worktree) it resumes from.
 */
export interface ForkLineage {
  /** The parent run's runId. */
  runId: string;
  /**
   * `refs/shiba/checkpoints/<parentSandboxId>/<seq>` — a hidden ref in the
   * parent worktree the fork's executor restores into its own clone.
   */
  checkpointRef: string;
}

/**
 * The token/cost numbers one harness-reported usage block carries. Every
 * field is optional: parsers copy what the CLI emitted and omit the rest,
 * so a reported cost never implies reported token counts or vice versa.
 */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * Fold a per-step usage delta into the accumulated totals: sums each field
 * the delta actually reported and leaves untouched fields untouched, so a
 * field is present iff some report carried it. A run-cumulative report
 * (e.g. a final result envelope) replaces rather than merges — the caller
 * knows which form the harness emitted and picks accordingly.
 */
export function mergeRunUsage(base: RunUsage | undefined, delta: RunUsage | undefined): RunUsage | undefined {
  if (base === undefined) return delta === undefined ? undefined : { ...delta };
  if (delta === undefined) return { ...base };
  const merged: RunUsage = {};
  if (base.inputTokens !== undefined || delta.inputTokens !== undefined) {
    merged.inputTokens = (base.inputTokens ?? 0) + (delta.inputTokens ?? 0);
  }
  if (base.outputTokens !== undefined || delta.outputTokens !== undefined) {
    merged.outputTokens = (base.outputTokens ?? 0) + (delta.outputTokens ?? 0);
  }
  if (base.costUsd !== undefined || delta.costUsd !== undefined) {
    merged.costUsd = (base.costUsd ?? 0) + (delta.costUsd ?? 0);
  }
  return merged;
}

export type RunPatch = {
  summary?: string;
  error?: string;
  errorCode?: RunErrorCode;
  diff?: string;
  pullUrl?: string;
  screenshotUrl?: string | null;
  browserE2eManifestUrl?: string | null;
  receipts?: Receipt[];
  sandboxId?: string;
  signals?: RunSignal[];
  continuationKey?: string;
  usage?: RunUsage;
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
