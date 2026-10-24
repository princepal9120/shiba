/**
 * Durable pending-approval records: the wire shape `/api/approvals` serves
 * and the pure list transforms the orchestrator applies to DO state.
 */
import type { RuntimeSelection } from "./local-runtime.js";
import type { ApprovedRoute } from "./model.js";
import type { AgentRole } from "./roles.js";
import type { ForkLineage } from "./runs.js";
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
// Marker interface; see above.
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
export type ApprovalKind = "run" | "email_send" | "email_delete" | "pr_merge";

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
  /** When true, the same approval covers a read-only review after the PR opens. */
  reviewAfterPublish?: boolean;
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
  /** T51: the machine a local run is pinned to ("Run on: This computer"); hashed. */
  targetMachineId?: string;
  /** The test command the human approved, as argv. */
  testCommand?: string[];
  /**
   * Run-fork lineage frozen with the rest of the approved input: the
   * parent runId + the checkpoint ref the fork resumes from. The approval
   * card names the lineage, and the input hash covers it — a fork is a
   * new decision, not a replay of the parent's.
   */
  forkedFrom?: ForkLineage;
  /** Phase 2b: parallel subagents this approval may spawn without a new card. */
  subagentBudget?: number;
  parentRunId?: string;
  subagentPath?: string;
  subagentSandbox?: import("./subagent.js").SubagentSandboxMode;
  captainId?: string;
  denId?: string;
  sandboxProvider?: string;
  customAgentId?: string;
  /** T68: env names + digest are hashed; values exist only inside `envSealed`. */
  envNames?: string[];
  envDigest?: string;
  envSealed?: string;
  /** T72: the human opted in to the repo's `.shiba/setup.json` initialize. */
  runSetup?: boolean;
  orgId?: string;
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
  reviewAfterPublish?: boolean;
  route?: ApprovedRoute;
  harness?: string;
  authAccount?: string;
  runtime?: RuntimeSelection;
  targetMachineId?: string;
  testCommand?: string[];
  forkedFrom?: ForkLineage;
  subagentBudget?: number;
  parentRunId?: string;
  subagentPath?: string;
  subagentSandbox?: import("./subagent.js").SubagentSandboxMode;
  captainId?: string;
  denId?: string;
  sandboxProvider?: string;
  customAgentId?: string;
  envNames?: string[];
  envDigest?: string;
  envSealed?: string;
  runSetup?: boolean;
  orgId?: string;
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
      ...(input.reviewAfterPublish !== undefined ? { reviewAfterPublish: input.reviewAfterPublish } : {}),
      ...(input.route !== undefined ? { route: input.route } : {}),
      ...(input.harness !== undefined ? { harness: input.harness } : {}),
      ...(input.authAccount !== undefined ? { authAccount: input.authAccount } : {}),
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      ...(input.targetMachineId !== undefined ? { targetMachineId: input.targetMachineId } : {}),
      ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
      ...(input.forkedFrom !== undefined ? { forkedFrom: input.forkedFrom } : {}),
      ...(input.subagentBudget !== undefined ? { subagentBudget: input.subagentBudget } : {}),
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      ...(input.subagentPath !== undefined ? { subagentPath: input.subagentPath } : {}),
      ...(input.subagentSandbox !== undefined ? { subagentSandbox: input.subagentSandbox } : {}),
      ...(input.captainId !== undefined ? { captainId: input.captainId } : {}),
      ...(input.denId !== undefined ? { denId: input.denId } : {}),
      ...(input.sandboxProvider !== undefined ? { sandboxProvider: input.sandboxProvider } : {}),
      ...(input.customAgentId !== undefined ? { customAgentId: input.customAgentId } : {}),
      ...(input.envNames !== undefined ? { envNames: input.envNames } : {}),
      ...(input.envDigest !== undefined ? { envDigest: input.envDigest } : {}),
      ...(input.envSealed !== undefined ? { envSealed: input.envSealed } : {}),
      ...(input.runSetup === true ? { runSetup: true } : {}),
      ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
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
  reviewAfterPublish?: boolean;
  /** Reviewer runs name the coding run the original approval already covered. */
  reviewOf?: string;
  route?: ApprovedRoute;
  /** T48: which subscription account — part of what the human approved. */
  authAccount?: string;
  /** T51: which runtime — part of what the human approved. */
  runtime?: RuntimeSelection;
  /** T51: which machine a local run may be claimed by — part of what the human approved. */
  targetMachineId?: string;
  /** The test command — part of what the human approved. */
  testCommand?: string[];
  /** Run-fork lineage — part of what the human approved. */
  forkedFrom?: ForkLineage;
  /** Phase 2b: subagent spawns the root approval may cover without a new card. */
  subagentBudget?: number;
  parentRunId?: string;
  subagentPath?: string;
  subagentSandbox?: import("./subagent.js").SubagentSandboxMode;
  captainId?: string;
  denId?: string;
  sandboxProvider?: string;
  customAgentId?: string;
  /** T68: what the human approves about env — names and a digest, never values. */
  envNames?: string[];
  envDigest?: string;
  /** T72: running the repo's own setup script is part of what the human approves. */
  runSetup?: boolean;
  role?: AgentRole;
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

// SHA-256 round constants — the first 32 bits of the cube roots of the first
// 64 primes (FIPS 180-4 §4.2.2).
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Synchronous SHA-256 hex. Approval evidence binds the human's decision to a
 * canonical input through this hash — a non-cryptographic fingerprint (the
 * previous 32-bit FNV-1a) is cheaply collidable, which would let a caller
 * swap approved content. Pure TS + TextEncoder keeps @shiba/shared free of
 * node:/DOM imports; crypto.subtle is async-only and callers are sync.
 */
function sha256HexSync(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // 64-bit big-endian bit length, split into hi/lo words (messages here are
  // far below 2^53 bits, so lo = length * 8 is exact).
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length << 3) >>> 0);
  const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(block + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** SHA-256 over a canonical JSON value — binds evidence to exact content. */
export function stableHash(value: JsonValue): string {
  return sha256HexSync(stableJson(value));
}

/** SHA-256 over the canonical input — binds approval evidence to the run. */
export function runInputHash(input: RunInputFields): string {
  const tc = input.testCommand;
  return stableHash({
    repoUrl: input.repoUrl,
    task: input.task,
    baseBranch: input.baseBranch,
    publishPullRequest: input.publishPullRequest,
    ...(input.reviewAfterPublish !== undefined ? { reviewAfterPublish: input.reviewAfterPublish } : {}),
    ...(input.reviewOf !== undefined ? { reviewOf: input.reviewOf } : {}),
    ...(input.route !== undefined ? { route: input.route as unknown as JsonValue } : {}),
    ...(input.authAccount !== undefined ? { authAccount: input.authAccount } : {}),
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
    ...(input.targetMachineId !== undefined ? { targetMachineId: input.targetMachineId } : {}),
    ...(tc !== undefined && tc.length > 0 ? { testCommand: tc } : {}),
    ...(input.forkedFrom !== undefined
      ? { forkedFrom: input.forkedFrom as unknown as JsonValue }
      : {}),
    ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
    ...(input.subagentPath !== undefined ? { subagentPath: input.subagentPath } : {}),
    ...(input.subagentSandbox !== undefined ? { subagentSandbox: input.subagentSandbox } : {}),
    ...(input.captainId !== undefined ? { captainId: input.captainId } : {}),
    ...(input.denId !== undefined ? { denId: input.denId } : {}),
    ...(input.sandboxProvider !== undefined ? { sandboxProvider: input.sandboxProvider } : {}),
    ...(input.customAgentId !== undefined ? { customAgentId: input.customAgentId } : {}),
    ...(input.envNames !== undefined ? { envNames: input.envNames } : {}),
    ...(input.envDigest !== undefined ? { envDigest: input.envDigest } : {}),
    ...(input.runSetup === true ? { runSetup: true } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.subagentBudget !== undefined ? { subagentBudget: input.subagentBudget } : {}),
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
