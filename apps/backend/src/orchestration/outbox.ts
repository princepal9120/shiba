/**
 * PLAN-V2-NEXT P9 — the effect outbox.
 *
 * Side effects (Slack posts, email sends, chat write-backs, webhook
 * emits) are *requested* as spine events first; the outbox rows the
 * projector derives from those requests are what actually executes.
 * A drainer runs them and records the result — dispatched or failed —
 * back onto the spine, so a DO that wakes mid-effect (crash, eviction,
 * reclaim) sees `pending` rows and retries instead of losing the post.
 * `attempts` + `lastError` drive the retry policy; a request that
 * already dispatched is never re-sent — callers dedupe on the stable
 * `fx:` id, so a retried command can't double-post.
 */
import type { OutboxEntry } from "@shiba/shared";

export const MAX_OUTBOX_ATTEMPTS = 3;

/** Entries the drainer may execute right now. */
export function dueEntries(outbox: OutboxEntry[] | undefined): OutboxEntry[] {
  return (outbox ?? []).filter((entry) => entry.status === "pending" || entry.status === "failed");
}

/** Entries still owed work after MAX_OUTBOX_ATTEMPTS — surfaced for operator triage. */
export function exhaustedEntries(outbox: OutboxEntry[] | undefined): OutboxEntry[] {
  return (outbox ?? []).filter(
    (entry) => entry.status === "failed" && entry.attempts >= MAX_OUTBOX_ATTEMPTS,
  );
}

/**
 * Execute each due entry through `execute`, resolving `entry → result`
 * per row. The caller persists results as side_effect.* events in one
 * state write — the drainer itself stays storage-free and sync-safe
 * for use inside a DO's waitUntil or reclaim path.
 */
export async function drainOutbox(
  outbox: OutboxEntry[] | undefined,
  execute: (entry: OutboxEntry) => Promise<{ ok: boolean; error?: string }>,
): Promise<Array<{ entry: OutboxEntry; ok: boolean; error?: string }>> {
  const results: Array<{ entry: OutboxEntry; ok: boolean; error?: string }> = [];
  for (const entry of dueEntries(outbox)) {
    if (entry.attempts >= MAX_OUTBOX_ATTEMPTS) continue;
    try {
      results.push({ entry, ...(await execute(entry)) });
    } catch (error) {
      results.push({
        entry,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
