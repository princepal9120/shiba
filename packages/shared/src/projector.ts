/**
 * PLAN-V2-NEXT P9 — the pure projection: `apply(state, event) → state`.
 *
 * `OrchestratorState` on the DO is the materialized projection of the
 * append-only spine log. The projector is pure and total — every kind
 * folds into the read model so a replayed log reconstructs state
 * byte-for-byte (a `replayState` rebuild derives the same runs,
 * approvals, and outbox the live writes produced).
 */
import type { ApprovalEvidence, PendingApproval } from "./approvals.js";
import type { RunEvent } from "./decide.js";
import { applyRunEvents, type MakeReceipt } from "./decide.js";
import { MAX_SPINE_EVENTS, type SideEffectKind, type SpineEvent } from "./events.js";
import type { DelegatedRun, RunPatch } from "./runs.js";

/** A side effect the spine asked for — the durable unit the drainer executes. */
export interface OutboxEntry {
  id: string;
  effectKind: SideEffectKind | (string & {});
  target: string;
  summary?: string;
  status: "pending" | "dispatched" | "failed";
  attempts: number;
  requestedAt: number;
  dispatchedAt?: number;
  lastError?: string;
  /** The event that requested it — dispatched/failed events thread this as causationId. */
  requestedBy?: string;
  runId?: string;
}

/** The slice of OrchestratorState the spine projects. */
export interface SpineProjection {
  runs: DelegatedRun[];
  pendingApprovals?: PendingApproval[];
  events?: SpineEvent[];
  outbox?: OutboxEntry[];
}

export const emptySpineProjection: SpineProjection = { runs: [] };

/** Append an already-sequenced event to the log with the retention cap applied. */
export function appendToLog(log: SpineEvent[] | undefined, events: SpineEvent[]): SpineEvent[] {
  const next = [...(log ?? []), ...events];
  return next.length > MAX_SPINE_EVENTS ? next.slice(next.length - MAX_SPINE_EVENTS) : next;
}

/**
 * Re-run the decider-event payloads of a `run.*` spine event against the
 * matching run row. The spine stores the decider's decisions, so the
 * projection replays them through the same `applyRunEvents` the live
 * write path used — never a second copy of transition logic.
 */
function spineToDeciderEvent(event: SpineEvent): RunEvent | null {
  const p = event.payload;
  switch (event.kind) {
    case "run.proposed":
      return p && "run" in p
        ? {
            type: "run.queued",
            commandId: event.commandId,
            at: event.at,
            run: p.run as unknown as DelegatedRun,
          }
        : null;
    case "run.approved":
      return p && "approval" in p
        ? {
            type: "run.approved",
            commandId: event.commandId,
            at: event.at,
            approval: p.approval as unknown as ApprovalEvidence,
          }
        : null;
    case "run.started":
      return p && "approval" in p
        ? {
            type: "run.started",
            commandId: event.commandId,
            at: event.at,
            approval: p.approval as unknown as ApprovalEvidence,
          }
        : { type: "run.started", commandId: event.commandId, at: event.at };
    case "run.completed":
      return {
        type: "run.completed",
        commandId: event.commandId,
        at: event.at,
        patch: (p && "patch" in p ? p.patch : {}) as RunPatch,
      };
    case "run.failed":
      return {
        type: "run.failed",
        commandId: event.commandId,
        at: event.at,
        status: p && "status" in p && p.status === "unknown" ? "unknown" : "error",
        patch: (p && "patch" in p ? p.patch : {}) as RunPatch,
      };
    case "run.cancelled":
      return {
        type: "run.cancelled",
        commandId: event.commandId,
        at: event.at,
        patch: (p && "patch" in p ? p.patch : {}) as RunPatch | undefined,
      };
    case "run.progress":
    case "run.checkpointed":
    case "run.rejected":
      return null;
    default:
      return null;
  }
}

/**
 * Fold one spine event into the projection. `make` is the receipt
 * injector the run-row projection needs (same seam as `applyRunEvents`).
 */
export function applySpineEvent<S extends SpineProjection>(
  state: S,
  event: SpineEvent,
  make: MakeReceipt,
): S {
  const next: SpineProjection = {
    ...state,
    events: appendToLog(state.events, [event]),
  };

  if (event.kind.startsWith("run.") && event.runId !== undefined) {
    const deciderEvent = spineToDeciderEvent(event);
    if (deciderEvent !== null) {
      next.runs = (state.runs ?? []).map((run) =>
        run.runId === event.runId ? (applyRunEvents(run, [deciderEvent], make) ?? run) : run,
      );
      // run.proposed mints the row; the map only rewrites existing rows.
      if (event.kind === "run.proposed" && !next.runs.some((run) => run.runId === event.runId)) {
        const minted = applyRunEvents(null, [deciderEvent], make);
        if (minted) next.runs = [...next.runs, minted];
      }
    }
  }

  if (event.kind === "approval.requested" && event.payload && "approval" in event.payload) {
    const approval = event.payload.approval as unknown as PendingApproval;
    const approvals = state.pendingApprovals ?? [];
    if (
      !approvals.some(
        (a) => a.approvalId === approval.approvalId && a.threadKey === approval.threadKey,
      )
    ) {
      next.pendingApprovals = [...approvals, approval];
    }
  }
  if (
    event.kind === "approval.answered" &&
    event.approvalId !== undefined &&
    event.payload &&
    "result" in event.payload
  ) {
    const result = event.payload.result;
    next.pendingApprovals = (state.pendingApprovals ?? []).map((a) =>
      a.approvalId === event.approvalId
        ? { ...a, status: result as PendingApproval["status"], decidedBy: event.commandId }
        : a,
    );
  }

  next.outbox = foldOutboxEvent(next.outbox, event);

  return next as S;
}

/**
 * Fold a side_effect.* event into the outbox rows — the piece of the
 * projection the DO also folds into live writes so the outbox stays
 * durable between the request and the drainer's next pass.
 */
export function foldOutboxEvent(
  outbox: OutboxEntry[] | undefined,
  event: SpineEvent,
): OutboxEntry[] | undefined {
  if (event.kind === "side_effect.requested" && event.payload && "effectId" in event.payload) {
    const { effectId, effectKind, target, summary } = event.payload;
    const rows = outbox ?? [];
    if (rows.some((entry) => entry.id === effectId)) return rows;
    return [
      ...rows,
      {
        id: effectId,
        effectKind: effectKind as SideEffectKind,
        target,
        summary,
        status: "pending" as const,
        attempts: 0,
        requestedAt: event.at,
        requestedBy: event.commandId,
        runId: event.runId,
      },
    ];
  }
  if (
    (event.kind === "side_effect.dispatched" || event.kind === "side_effect.failed") &&
    event.payload &&
    "effectId" in event.payload
  ) {
    const { effectId, error } = event.payload;
    return (outbox ?? []).map((entry) =>
      entry.id === effectId
        ? {
            ...entry,
            status:
              event.kind === "side_effect.dispatched"
                ? ("dispatched" as const)
                : ("failed" as const),
            attempts: entry.attempts + 1,
            dispatchedAt: event.kind === "side_effect.dispatched" ? event.at : entry.dispatchedAt,
            lastError: error ?? entry.lastError,
          }
        : entry,
    );
  }
  return outbox;
}

/** Replay a log from scratch — the projection's proof it is derived, not stored truth. */
export function replaySpine<S extends SpineProjection>(
  initial: S,
  log: SpineEvent[],
  make: MakeReceipt,
): S {
  return log.reduce((state, event) => applySpineEvent(state, event, make), initial);
}

/** `commandId` of the event a payload references — causation threading for the outbox. */
export function effectIdFor(commandId: string, effectKind: string): string {
  return `fx:${effectKind}:${commandId}`;
}
