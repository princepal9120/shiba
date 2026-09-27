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
  isJsonValue,
  MAX_COMMAND_RECEIPTS,
  pruneExpiredApprovals,
  putCommandReceipt,
  recordApprovalExecution,
  resolvePendingApproval,
  runInputHash,
} from "@shiba/shared";
export type {
  ApprovalEvidence,
  ApprovalExecution,
  ApprovalKind,
  CommandKind,
  CommandReceipt,
  CreateApprovalInput,
  JsonArray,
  JsonObject,
  JsonValue,
  PendingApproval,
  ResolveApprovalInput,
  ResolveResult,
  RunInputFields,
} from "@shiba/shared";
