import { stableHash, type JsonValue } from "./approvals.js";

/**
 * Durable command receipts (T41): one receipt per processed command,
 * keyed by a caller-deterministic commandId and committed in the same
 * state write as the effect it records — the t3code invariant that
 * event, projection, and accepted receipt commit atomically. A
 * redelivery reads the receipt and gets the original answer instead of
 * re-running the command: a retried resolve, a double-fired webhook
 * fan-out, or a retried queue can never mint the effect twice.
 */
export type CommandKind = "approval.resolve" | "run.queue";

export const MAX_COMMAND_RECEIPTS = 256;

export interface CommandReceipt {
  /** Caller-deterministic id: `approval:<approvalId>` or `queue:<key>`. */
  commandId: string;
  kind: CommandKind;
  /** The completed outcome a replay must learn: "approved" | "rejected" | "queued". */
  outcome: string;
  /**
   * approval.resolve receipts only: a replay answers for the same
   * threadKey — a resolve naming the right approvalId but a different
   * threadKey re-litigates normally.
   */
  threadKey?: string;
  /** run.queue receipts: the minted approval id a replay returns. */
  approvalId?: string;
  /** approval.resolve receipts: the minted run id. */
  runId?: string;
  /**
   * approval.resolve receipts: true once the run dispatch was
   * scheduled (or its effect already landed). The onStart re-drive
   * reads this flag, not the run record, so the decision is replayed
   * at most once.
   */
  dispatched?: boolean;
  at: number;
}

/** Insert a receipt, evicting the oldest past MAX_COMMAND_RECEIPTS. */
export function putCommandReceipt(
  receipts: Record<string, CommandReceipt>,
  receipt: CommandReceipt,
): Record<string, CommandReceipt> {
  const next = { ...receipts, [receipt.commandId]: receipt };
  const keys = Object.keys(next);
  if (keys.length <= MAX_COMMAND_RECEIPTS) return next;
  // Oldest `at` leaves first; commandId breaks ties deterministically.
  const sorted = keys.sort(
    (a, b) => (next[a] as CommandReceipt).at - (next[b] as CommandReceipt).at || a.localeCompare(b),
  );
  for (const key of sorted.slice(0, keys.length - MAX_COMMAND_RECEIPTS)) {
    delete next[key];
  }
  return next;
}

/**
 * Deterministic commandId for one automation firing on one event, or
 * undefined when the event carries no dedupe identity (webhook/manual
 * fires — nothing distinguishes a caller retry from a repeat request).
 * GitHub events key on the delivery id when forwarded, else a
 * fingerprint of the whole mapped event; Slack keys on the envelope
 * `event_id` or the same fallback; schedule ticks key on the minute
 * bucket of the firing instant so a retried tick cannot double-queue.
 * The `event` is the caller's mapped event object (kind + fields) — the
 * fingerprint hashes it whole.
 */
export function automationCommandId(
  automationId: string,
  event: object,
): string | undefined {
  const e = event as { kind?: unknown; deliveryId?: unknown; eventId?: unknown; nowMs?: unknown };
  switch (e.kind) {
    case "github": {
      const deliveryId = typeof e.deliveryId === "string" ? e.deliveryId : "";
      return `automation:${automationId}:gh:${
        deliveryId !== "" ? deliveryId : `fp:${stableHash(event as JsonValue)}`
      }`;
    }
    case "slack": {
      const eventId = typeof e.eventId === "string" ? e.eventId : "";
      return `automation:${automationId}:slack:${
        eventId !== "" ? eventId : `fp:${stableHash(event as JsonValue)}`
      }`;
    }
    case "schedule": {
      const nowMs = typeof e.nowMs === "number" ? e.nowMs : Date.now();
      return `automation:${automationId}:sched:${new Date(nowMs).toISOString().slice(0, 16)}`;
    }
    default:
      return undefined;
  }
}
