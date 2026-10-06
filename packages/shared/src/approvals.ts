/**
 * Durable pending-approval records: the wire shape `/api/approvals` serves
 * and the pure list transforms the orchestrator applies to DO state.
 */
import type { RuntimeSelection } from "./local-runtime.js";
import type { ApprovedRoute } from "./model.js";
import type { AgentRole } from "./roles.js";
import { MAX_PENDING_APPROVALS } from "./steering.js";

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
 * instantiation defers named references instead of blowing the
 * instantiation-depth budget.
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
  /**
   * The frozen, approval-gated route: connection/model/harness ids only.
   * The human approves exactly this; dispatch revalidates it and never
   * substitutes another model.
   */
  route?: ApprovedRoute;
  /**
   * Legacy-only: records queued before route freezing carry this instead of
   * `route`. Dispatch falls back to it so an old approval keeps its agent.
   */
  harness?: string;
  /**
   * T48: the subscription account a subscription-authed harness runs under
   * (an account NAME, never a credential). Frozen at queue time and hashed
   * like the rest of the approved input.
   */
  authAccount?: string;
  /**
   * T51: the approved runtime — `"local"` runs on the operator's machine
   * via the dispatch mailbox; absent = sandbox. Frozen at queue time and
   * hashed like the rest of the approved input.
   */
  runtime?: RuntimeSelection;
  /** The test command the human approved, as argv. */
  testCommand?: string[];
  /**
   * T52: the delegation role this run was queued under. The role pin
   * already resolved into `route` at queue time — this rides along as
   * frozen provenance so dispatch threads it into the run envelope.
   */
  role?: AgentRole;
  /** Approval kind; absent on records written before email kinds landed — treated as `"run"`. */
  kind?: ApprovalKind;
  /** Frozen email send/delete input for email-kind approvals. */
  payload?: JsonValue;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedBy?: string;
  decidedAt?: number;
  /**
   * MCP principal that queued this approval (X-Agent-Principal at intake).
   * Absent on operator-queued records — agent tokens only list their own.
   */
  queuedBy?: string;
  /**
   * Executor outcome for email-kind approvals, written after the
   * post-decision dispatch settles. Absent while execution is in flight
   * or never ran; run-kind records omit it — their durable outcome is
   * the reserved run's terminal status.
   */
  execution?: ApprovalExecution;
}

/** What the email executor did with an approved payload. */
export interface ApprovalExecution {
  status: "executed" | "failed";
  /** Redacted error text when `status` is `"failed"`. */
  error?: string;
  executedAt: number;
}

export interface CreateApprovalInput {
  threadKey: string;
  approvalId: string;
  repoUrl: string;
  task: string;
  baseBranch?: string;
  publishPullRequest?: boolean;
  route?: ApprovedRoute;
  harness?: string;
  authAccount?: string;
  runtime?: RuntimeSelection;
  testCommand?: string[];
  role?: AgentRole;
  kind?: ApprovalKind;
  payload?: JsonValue;
  queuedBy?: string;
  createdAt: number;
}

export function createPendingApproval(
  approvals: PendingApproval[],
  input: CreateApprovalInput,
): PendingApproval[] {
  if (approvals.some((a) => a.approvalId === input.approvalId)) {
    throw new Error(`Approval ${input.approvalId} is already pending or resolved.`);
  }
  if (approvals.filter((a) => a.status === "pending").length >= MAX_PENDING_APPROVALS) {
    throw new Error("Approval queue is full — resolve pending approvals first.");
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
      ...(input.route !== undefined ? { route: input.route } : {}),
      ...(input.harness !== undefined ? { harness: input.harness } : {}),
      ...(input.authAccount !== undefined ? { authAccount: input.authAccount } : {}),
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.queuedBy !== undefined ? { queuedBy: input.queuedBy } : {}),
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

/**
 * Stamp the executor outcome onto a decided approval. Run-kind records
 * never call this — their outcome is the run's terminal status.
 */
export function recordApprovalExecution(
  approvals: PendingApproval[],
  input: { threadKey: string; approvalId: string; execution: ApprovalExecution },
): PendingApproval[] {
  return approvals.map((approval) =>
    approval.approvalId === input.approvalId && approval.threadKey === input.threadKey
      ? { ...approval, execution: input.execution }
      : approval,
  );
}

/** Drop pending approvals past their TTL; resolved records stay for audit. */
export function pruneExpiredApprovals(approvals: PendingApproval[], now: number): PendingApproval[] {
  return approvals.filter((a) => a.status !== "pending" || !isApprovalExpired(a, now));
}

/**
 * Depth of decided history the approvals listing returns — bounded so a
 * long-lived orchestrator's audit tail cannot grow the wire shape
 * without limit.
 */
export const DECIDED_APPROVALS_LIMIT = 25;

/**
 * Recent decided records (approved or rejected), newest first — the
 * readable half of the audit trail. Pending pointers never appear, so
 * the two arms of the listing stay disjoint.
 */
export function decidedApprovals(approvals: PendingApproval[]): PendingApproval[] {
  return approvals
    .filter((approval) => approval.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .slice(0, DECIDED_APPROVALS_LIMIT);
}

/**
 * Bounded retention for the approvals store: pending records already
 * TTL-prune, but decided ones accumulated forever in DO state. The
 * listing only ever serves the newest DECIDED_APPROVALS_LIMIT, so the
 * store keeps exactly that tail — decidedApprovals()'s output is
 * unchanged — and evicts the rest.
 */
export function pruneApprovals(approvals: PendingApproval[], now: number): PendingApproval[] {
  const alive = pruneExpiredApprovals(approvals, now);
  if (alive.filter((a) => a.status !== "pending").length <= DECIDED_APPROVALS_LIMIT) {
    return alive;
  }
  const keep = new Set(decidedApprovals(alive).map((a) => a.approvalId));
  return alive.filter((a) => a.status === "pending" || keep.has(a.approvalId));
}

/** Approval expiry shares the pointer contract; see resolvePendingApproval. */
export function isApprovalExpired(record: PendingApproval, now: number): boolean {
  return now - record.createdAt > APPROVAL_TTL_MS;
}

/**
 * The proof a run carries into `running` (T40): who approved it, when, and
 * the hash of the exact frozen input they approved. Stored on the run record
 * at queue time and re-asserted on the `start` command — a run with no
 * evidence, mismatched approver, or an input that drifted from the card
 * cannot start.
 */
export interface ApprovalEvidence {
  approvalId: string;
  decidedBy: string;
  decidedAt: number;
  inputHash: string;
}

/** The fields the human approves — the input-hash surface. */
export interface RunInputFields {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  route?: ApprovedRoute;
  /** T48: which subscription account — part of what the human approved. */
  authAccount?: string;
  /** T51: which runtime — part of what the human approved. */
  runtime?: RuntimeSelection;
  /** The test command — part of what the human approved. */
  testCommand?: string[];
}

/** Key-sorted JSON — the canonical form the input hash covers. */
export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key]!)}`);
  return `{${entries.join(",")}}`;
}

/** FNV-1a over a canonical JSON value — a tamper check, not a credential. */
export function stableHash(value: JsonValue): string {
  const canonical = stableJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** FNV-1a over the canonical input — a tamper check, not a credential. */
export function runInputHash(input: RunInputFields): string {
  const tc = input.testCommand;
  return stableHash({
    repoUrl: input.repoUrl,
    task: input.task,
    baseBranch: input.baseBranch,
    publishPullRequest: input.publishPullRequest,
    ...(input.route !== undefined ? { route: input.route as unknown as JsonValue } : {}),
    ...(input.authAccount !== undefined ? { authAccount: input.authAccount } : {}),
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
    ...(tc !== undefined && tc.length > 0 ? { testCommand: tc } : {}),
  });
}

/**
 * Build the evidence a resolved approval record produces for a run. `input`
 * is the post-default run shape (baseBranch defaults applied) so the hash
 * matches `runInputHash` on the stored record at `start`.
 */
export function approvalEvidenceFor(record: PendingApproval, input: RunInputFields): ApprovalEvidence {
  return {
    approvalId: record.approvalId,
    decidedBy: record.decidedBy ?? "unknown",
    decidedAt: record.decidedAt ?? record.createdAt,
    inputHash: runInputHash(input),
  };
}
