/**
 * Durable pending-approval records — the shape and the pure list
 * transforms now live in @shiba/shared (the dashboard reads the same
 * record off /api/approvals). Re-exported for existing imports.
 */
export {
  APPROVAL_TTL_MS,
  createPendingApproval,
  decidedApprovals,
  DECIDED_APPROVALS_LIMIT,
  isApprovalExpired,
  isJsonObject,
  isJsonValue,
  pruneExpiredApprovals,
  recordApprovalExecution,
  resolvePendingApproval,
} from "@shiba/shared";
export type {
  ApprovalExecution,
  ApprovalKind,
  CreateApprovalInput,
  JsonArray,
  JsonObject,
  JsonValue,
  PendingApproval,
  ResolveApprovalInput,
  ResolveResult,
} from "@shiba/shared";
