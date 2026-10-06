/**
 * T40 test seam. `delegate.execute`/`executeDelegatedTask` no longer mint
 * runs — only the /api/approvals resolve path does, writing an approved
 * pointer plus a reserved pending run carrying the approval evidence. This
 * helper reproduces exactly that state so tests exercise the same path
 * production takes. Anything calling execute without it must be refused.
 */
import {
  approvalEvidenceFor,
  createPendingApproval,
  resolvePendingApproval,
  runInputHash,
  type ApprovalEvidence,
  type PendingApproval,
  type RunInputFields,
} from "../src/pending-approvals.js";
import { createRun, type DelegatedRun } from "../src/runs.js";
import type { ApprovedRoute } from "../src/model-connections.js";

export interface SeedInput {
  repoUrl: string;
  task: string;
  baseBranch?: string;
  publishPullRequest?: boolean;
  route?: ApprovedRoute;
  /** T51: the approved runtime the pointer reserves. */
  runtime?: "sandbox" | "local";
}

type SeedableState = { runs: DelegatedRun[]; pendingApprovals?: PendingApproval[] };

export interface SeedHost<S extends SeedableState = SeedableState> {
  state: S;
  setState(next: S): void;
}

/** Standalone evidence for direct createRun use (runs.test.ts-style). */
export function evidenceFor(input: RunInputFields, approvalId = "ap-test"): ApprovalEvidence {
  return {
    approvalId,
    decidedBy: "test",
    decidedAt: 1_000,
    inputHash: runInputHash(input),
  };
}

export const SEED_INPUT: SeedInput = {
  repoUrl: "https://github.com/o/r",
  task: "fix",
  baseBranch: "main",
  publishPullRequest: false,
};

/**
 * The crash window T41 covers: the approved pointer persisted but the
 * run mint (and its command receipt) never landed. Used to prove the
 * onStart re-drive closes the "approved with no run" gap exactly once.
 */
export function approvePointerOnly<S extends SeedableState>(
  host: SeedHost<S>,
  callId: string,
  input: SeedInput = SEED_INPUT,
): void {
  const now = Date.now();
  const created = createPendingApproval([], {
    threadKey: "default",
    approvalId: callId,
    repoUrl: input.repoUrl,
    task: input.task,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.publishPullRequest !== undefined ? { publishPullRequest: input.publishPullRequest } : {}),
    ...(input.route !== undefined ? { route: input.route } : {}),
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
    createdAt: now - 1_000,
  });
  const { approvals } = resolvePendingApproval(
    created,
    { threadKey: "default", approvalId: callId, approved: true, decidedBy: "test" },
    now,
  );
  // Two commits, like production: the queue write lands the pending pointer
  // (approval.requested), the resolve write lands the decision (answered) —
  // a spine-aware setState folds the same event pair the real route emits.
  host.setState({ ...host.state, pendingApprovals: created });
  host.setState({ ...host.state, pendingApprovals: approvals });
}

/** Mint `agent-tool:<callId>` as reserved+approved, like the resolve path. */
export function approveDirect<S extends SeedableState>(
  host: SeedHost<S>,
  callId: string,
  input: SeedInput = SEED_INPUT,
): void {
  approvePointerOnly(host, callId, input);
  const record = (host.state.pendingApprovals ?? []).find(
    (approval) => approval.approvalId === callId,
  )!;
  const frozen: RunInputFields = {
    repoUrl: record.repoUrl,
    task: record.task,
    baseBranch: record.baseBranch ?? "main",
    publishPullRequest: record.publishPullRequest ?? false,
    ...(record.route !== undefined ? { route: record.route } : {}),
    ...(record.runtime !== undefined ? { runtime: record.runtime } : {}),
  };
  const run = createRun({
    runId: `agent-tool:${callId}`,
    sandboxId: `sbx-${callId}`,
    ...frozen,
    ...(record.runtime !== undefined ? { runtime: record.runtime } : {}),
    approval: approvalEvidenceFor(record, frozen),
  });
  host.setState({
    ...host.state,
    runs: [...host.state.runs, run],
  });
}
