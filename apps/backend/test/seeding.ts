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

/** Mint `agent-tool:<callId>` as reserved+approved, like the resolve path. */
export function approveDirect<S extends SeedableState>(
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
    createdAt: now - 1_000,
  });
  const { approvals } = resolvePendingApproval(
    created,
    { threadKey: "default", approvalId: callId, approved: true, decidedBy: "test" },
    now,
  );
  const record = approvals.find((approval) => approval.approvalId === callId)!;
  const frozen: RunInputFields = {
    repoUrl: record.repoUrl,
    task: record.task,
    baseBranch: record.baseBranch ?? "main",
    publishPullRequest: record.publishPullRequest ?? false,
    ...(record.route !== undefined ? { route: record.route } : {}),
  };
  const run = createRun({
    runId: `agent-tool:${callId}`,
    sandboxId: `sbx-${callId}`,
    ...frozen,
    approval: approvalEvidenceFor(record, frozen),
  });
  host.setState({
    ...host.state,
    runs: [...host.state.runs, run],
    pendingApprovals: approvals,
  });
}
