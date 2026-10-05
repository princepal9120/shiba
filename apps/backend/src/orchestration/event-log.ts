/**
 * PLAN-V2-NEXT P9 — the DO's append-only event log.
 *
 * The log lives inside the persisted `OrchestratorState` so an append
 * lands in the same `setState` write as the state mutation the event
 * decided — one atomic commit, no separate storage transaction to
 * split. `seq` is per-orchestrator and monotonically increasing; the
 * tail is replayable through the projector. Retention caps at
 * MAX_SPINE_EVENTS (events stay an audit/debug trail, not an
 * unbounded ledger — command receipts carry the durable outcome).
 */
import { type SpineEvent, type SpineEventInput, spineEventSchema } from "@shiba/shared";

/**
 * Assign seq, validate each event, return the appended log tail.
 * `existing` is the retained tail — seq continues from its last entry,
 * so a capped log never reuses a seq. Throws on a malformed event:
 * appends happen inside state writes and a bad event must abort the
 * write, not persist a corrupt entry.
 */
export function appendBatch(
  existing: SpineEvent[] | undefined,
  inputs: SpineEventInput[],
): SpineEvent[] {
  let seq = existing?.length ? existing[existing.length - 1]!.seq : 0;
  return inputs.map((input) => spineEventSchema.parse({ ...input, seq: (seq += 1) }));
}

/** Seq the next append will use — exposed for causation threading. */
export function nextSeq(existing: SpineEvent[] | undefined): number {
  return (existing?.length ? existing[existing.length - 1]!.seq : 0) + 1;
}
