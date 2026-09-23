/**
 * Durable pending-approval records for the Slack approval path (finding #2).
 * Pure list transforms so the orchestrator stores them in DO state the same
 * way it stores runs; the click handler resolves a pointer exactly once.
 */

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** JSON-serializable value — the shape a frozen approval payload takes. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonArray
  | JsonObject;

/**
 * Array arm of {@link JsonValue} as a named interface — see JsonObject
 * for why the recursive arms are named interfaces rather than inline
 * types or aliases (only interface references defer instantiation).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- marker interface; see above
export interface JsonArray extends Array<JsonValue> {}

/**
 * Object arm of {@link JsonValue} as a named reference: deep generic
 * instantiation (agent stub types traversing `OrchestratorState`) defers
 * named references instead of blowing the instantiation-depth budget.
 */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * What an approval gates. `"run"` covers sandboxed delegation runs;
 * `"email_send"`/`"email_delete"` cover the frozen mailbox payloads the
 * orchestrator executes on approve instead of dispatching a run. Records
 * written before email approvals existed carry no `kind` — readers treat
 * absent as `"run"`.
 */
export type ApprovalKind = "run" | "email_send" | "email_delete";

/** Runtime check that `value` is JSON-serializable — the shape a JSON body parse produces. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

/** `isJsonValue` narrowed to the object arm — a JSON map payload. */
export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

export interface PendingApproval {
  threadKey: string;
  approvalId: string;
  repoUrl: string;
  task: string;
  /** Exact delegation input frozen at queue time; executed verbatim on approve. */
  baseBranch?: string;
  publishPullRequest?: boolean;
  /** Approval kind; absent on records written before email kinds landed — treated as `"run"`. */
  kind?: ApprovalKind;
  /** Frozen email send/delete input for email-kind approvals. */
  payload?: JsonValue;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedBy?: string;
  decidedAt?: number;
}

export interface CreateApprovalInput {
  threadKey: string;
  approvalId: string;
  repoUrl: string;
  task: string;
  baseBranch?: string;
  publishPullRequest?: boolean;
  kind?: ApprovalKind;
  payload?: JsonValue;
  createdAt: number;
}

export function createPendingApproval(
  approvals: PendingApproval[],
  input: CreateApprovalInput,
): PendingApproval[] {
  if (approvals.some((a) => a.approvalId === input.approvalId)) {
    throw new Error(`Approval ${input.approvalId} is already pending or resolved.`);
  }
  return [
    ...approvals,
    {
      threadKey: input.threadKey,
      approvalId: input.approvalId,
      repoUrl: input.repoUrl,
      task: input.task,
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      ...(input.publishPullRequest !== undefined ? { publishPullRequest: input.publishPullRequest } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      status: "pending",
      createdAt: input.createdAt,
    },
  ];
}

export interface ResolveApprovalInput {
  threadKey: string;
  approvalId: string;
  approved: boolean;
  decidedBy: string;
}

export type ResolveResult = "approved" | "rejected" | "expired" | "unknown";

export function resolvePendingApproval(
  approvals: PendingApproval[],
  input: ResolveApprovalInput,
  now: number,
): { result: ResolveResult; approvals: PendingApproval[] } {
  const index = approvals.findIndex(
    (a) => a.approvalId === input.approvalId && a.threadKey === input.threadKey,
  );
  if (index < 0) {
    return { result: "unknown", approvals };
  }
  const record = approvals[index]!;
  if (record.status !== "pending") {
    return { result: "unknown", approvals };
  }
  if (now - record.createdAt > APPROVAL_TTL_MS) {
    // Expired pointers resolve nothing and are pruned, like stale cards.
    return { result: "unknown", approvals: approvals.filter((a) => a.approvalId !== input.approvalId) };
  }
  const next = approvals.map((a, i) =>
    i === index
      ? { ...a, status: input.approved ? ("approved" as const) : ("rejected" as const), decidedBy: input.decidedBy, decidedAt: now }
      : a,
  );
  return { result: input.approved ? "approved" : "rejected", approvals: next };
}

/** Drop pending approvals past their TTL; resolved records stay for audit. */
export function pruneExpiredApprovals(approvals: PendingApproval[], now: number): PendingApproval[] {
  return approvals.filter((a) => a.status !== "pending" || !isApprovalExpired(a, now));
}

/** Approval expiry shares the pointer contract; see resolvePendingApproval. */
export function isApprovalExpired(record: PendingApproval, now: number): boolean {
  return now - record.createdAt > APPROVAL_TTL_MS;
}

