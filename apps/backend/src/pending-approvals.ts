/**
 * Durable pending-approval records — the shape and the pure list
 * transforms now live in @shiba/shared (the dashboard reads the same
 * record off /api/approvals). Re-exported for existing imports.
 */
export {
  APPROVAL_TTL_MS,
  approvalEvidenceFor,
  automationCommandId,
  createPendingApproval,
  decidedApprovals,
  DECIDED_APPROVALS_LIMIT,
  isApprovalExpired,
  isJsonObject,
  MAX_COMMAND_RECEIPTS,
  MAX_PENDING_APPROVALS,
  pruneApprovals,
  pruneExpiredApprovals,
  putCommandReceipt,
  recordApprovalExecution,
  resolvePendingApproval,
  runInputHash,
} from "@shiba/shared";
export type {
  ApprovalEvidence,
  ApprovalKind,
  CommandReceipt,
  PendingApproval,
  ResolveResult,
  RunInputFields,
} from "@shiba/shared";
