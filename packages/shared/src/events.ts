/**
 * PLAN-V2-NEXT P9 — the spine's event schema.
 *
 * `decide.ts` emits per-run `RunEvent`s; this file wraps them in a
 * durable envelope (`seq`, `commandId`, `causationId`) and adds the
 * DO-wide kinds the decider can't see: side-effect requests flowing
 * through the outbox and approval lifecycle events. The log in
 * `src/orchestration/event-log.ts` assigns `seq`; the projector in
 * `projector.ts` folds each event back into `OrchestratorState` —
 * the stored state is a projection, not the source of truth.
 */
import { z } from "zod";
import type { PendingApproval } from "./approvals.js";
import type { RunEvent } from "./decide.js";

export type RunSpineKind =
  | "run.proposed"
  | "run.approved"
  | "run.rejected"
  | "run.started"
  | "run.progress"
  | "run.checkpointed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.forked";

export type SideEffectKind =
  | "slack.post"
  | "chat.post"
  | "email.send"
  | "github.push"
  | "webhook.emit"
  | "session.distill";

export type SpineKind =
  | RunSpineKind
  | "side_effect.requested"
  | "side_effect.dispatched"
  | "side_effect.failed"
  | "approval.requested"
  | "approval.answered";

export const SPINE_KINDS: readonly SpineKind[] = [
  "run.proposed",
  "run.approved",
  "run.rejected",
  "run.started",
  "run.progress",
  "run.checkpointed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.forked",
  "side_effect.requested",
  "side_effect.dispatched",
  "side_effect.failed",
  "approval.requested",
  "approval.answered",
];

const runPatchSchema = z.record(z.string(), z.unknown());
const delegatedRunSchema = z.record(z.string(), z.unknown());
const pendingApprovalSchema = z.record(z.string(), z.unknown());

/**
 * Payloads are schema-validated at append; narrow types live beside
 * each kind. Members are strict: a loose object would strip the
 * discriminating key (every member would parse through the
 * all-optional patch arm as `{}`).
 */
export const spineEventPayloadSchema = z.union([
  z.strictObject({ run: delegatedRunSchema }),
  z.strictObject({
    patch: runPatchSchema.optional(),
    status: z.string().optional(),
    summary: z.string().optional(),
  }),
  z.strictObject({ checkpointRef: z.string(), checkpointSeq: z.number() }),
  // run.forked: the fork's lineage + the approval it minted.
  z.strictObject({
    forkedFrom: z.strictObject({ runId: z.string(), checkpointRef: z.string() }),
  }),
  z.strictObject({ approval: pendingApprovalSchema }),
  z.strictObject({
    approvalId: z.string(),
    threadKey: z.string().optional(),
    result: z.enum(["approved", "rejected"]),
  }),
  z.strictObject({
    effectId: z.string(),
    effectKind: z.string(),
    target: z.string(),
    summary: z.string().optional(),
    error: z.string().optional(),
  }),
]);
export type SpinePayload = z.infer<typeof spineEventPayloadSchema>;

export const spineEventSchema = z.object({
  /** Per-orchestrator monotonically increasing sequence — assigned by the append log. */
  seq: z.number().int().positive(),
  at: z.number(),
  /** The command whose decision produced this event; `system:` ids for wake/reclaim paths. */
  commandId: z.string().min(1),
  /** The event that caused this one (a side_effect.requested caused by a run.failed, say). */
  causationId: z.string().optional(),
  kind: z.enum(SPINE_KINDS as [SpineKind, ...SpineKind[]]),
  runId: z.string().optional(),
  approvalId: z.string().optional(),
  payload: spineEventPayloadSchema.optional(),
});
export type SpineEvent = z.infer<typeof spineEventSchema>;

/** Input shape: everything the log fills in minus `seq`. */
export type SpineEventInput = Omit<SpineEvent, "seq">;

/** How many spine events a DO keeps. Old entries drop first; seq is never reused. */
export const MAX_SPINE_EVENTS = 1000;

/** Per-run decider events → spine kinds. Rejected decisions emit no event. */
const DECIDER_TO_SPINE: Record<RunEvent["type"], RunSpineKind> = {
  "run.queued": "run.proposed",
  "run.approved": "run.approved",
  "run.started": "run.started",
  "run.completed": "run.completed",
  "run.failed": "run.failed",
  "run.aborted": "run.failed",
  "run.cancelled": "run.cancelled",
  "run.reclaimed": "run.failed",
};

/** Wrap a decider event batch as spine inputs sharing the producing commandId. */
export function spineInputsFromDecider(
  runId: string,
  commandId: string,
  events: RunEvent[],
  at: number,
): SpineEventInput[] {
  return events.map((event) => {
    const kind = DECIDER_TO_SPINE[event.type];
    const input: SpineEventInput = { kind, commandId, at: event.at ?? at, runId };
    switch (event.type) {
      case "run.queued":
        input.payload = { run: event.run as unknown as Record<string, unknown> };
        break;
      case "run.approved":
        input.payload = { approval: event.approval as unknown as Record<string, unknown> };
        break;
      case "run.completed":
      case "run.aborted":
      case "run.cancelled":
      case "run.failed":
      case "run.reclaimed":
        input.payload = {
          patch: event.patch as unknown as Record<string, unknown>,
          ...(event.type === "run.failed" ? { status: event.status } : {}),
          ...(event.patch?.summary ? { summary: event.patch.summary } : {}),
        };
        break;
      case "run.started":
        input.payload = event.approval
          ? { approval: event.approval as unknown as Record<string, unknown> }
          : undefined;
        break;
    }
    return input;
  });
}

export function sideEffectRequestInput(args: {
  effectId: string;
  effectKind: SideEffectKind;
  target: string;
  summary?: string;
  commandId: string;
  causationId?: string;
  runId?: string;
  at: number;
}): SpineEventInput {
  const { commandId, causationId, runId, at, effectId, effectKind, target, summary } = args;
  return {
    kind: "side_effect.requested",
    commandId,
    causationId,
    runId,
    at,
    payload: { effectId, effectKind, target, summary },
  };
}

export function sideEffectResultInput(args: {
  effectId: string;
  effectKind: SideEffectKind;
  target: string;
  ok: boolean;
  error?: string;
  commandId: string;
  causationId?: string;
  at: number;
}): SpineEventInput {
  const { commandId, causationId, at, effectId, effectKind, target, ok, error } = args;
  return {
    kind: ok ? "side_effect.dispatched" : "side_effect.failed",
    commandId,
    causationId,
    at,
    payload: { effectId, effectKind, target, error },
  };
}

export function approvalEventInput(args: {
  approval: PendingApproval;
  result?: "approved" | "rejected";
  commandId: string;
  at: number;
}): SpineEventInput {
  const { approval, result, commandId, at } = args;
  return result === undefined
    ? {
        kind: "approval.requested",
        commandId,
        at,
        approvalId: approval.approvalId,
        payload: { approval: approval as unknown as Record<string, unknown> },
      }
    : {
        kind: "approval.answered",
        commandId,
        at,
        approvalId: approval.approvalId,
        payload: { approvalId: approval.approvalId, threadKey: approval.threadKey, result },
      };
}
