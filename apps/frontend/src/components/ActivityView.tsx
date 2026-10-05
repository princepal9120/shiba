import { useEffect, type JSX } from "react";
import { LoadErrorState } from "./LoadErrorState";
import { useSpine, type OutboxEntryWire, type SpineEventWire } from "../live-status";

/**
 * Orchestrator activity — the P9 event spine, surfaced. Two panels:
 *   - Event log: what the orchestrator decided, newest first.
 *   - Outbox: side effects it still owes (Slack/email posts, pushes).
 * Polls lightly while mounted so the feed tracks live decisions.
 */
export function ActivityView({
  sessionId,
  sessionApiAvailable,
}: {
  sessionId: string;
  sessionApiAvailable: boolean;
}): JSX.Element {
  const { state, reload } = useSpine(sessionId, sessionApiAvailable);

  useEffect(() => {
    const timer = window.setInterval(reload, 5_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const events = state.kind === "data" ? state.data.events : [];
  const outbox = state.kind === "data" ? state.data.outbox : [];
  const pending = outbox.filter((entry) => entry.status === "pending");

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#222320]">Orchestrator activity</h2>
          <p className="text-xs text-[#6a6f63]">
            What your agent decided and the side effects it still owes — the event spine, live.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {pending.length > 0 ? (
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8a5a00] bg-[#f4b400]/15 border border-[#f4b400]/40 px-2 py-1">
              {pending.length} owed
            </span>
          ) : null}
          <button
            type="button"
            onClick={reload}
            className="text-xs text-[#1c1cc8] hover:text-[#0000a8] border border-[#e0ded5] hover:border-[#0000a8]/40 bg-transparent px-3 py-1.5 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-5xl mx-auto grid gap-4 lg:grid-cols-[1fr_320px]">
          <section
            aria-label="Event log"
            className="border border-[#e0ded5] bg-[#fffef8] shadow-[3px_3px_0_var(--paper-shadow)]"
          >
            <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
              Event log
            </div>
            {state.kind === "loading" ? (
              <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">Reading the spine…</div>
            ) : state.kind === "error" ? (
              <LoadErrorState message={state.message} onRetry={reload} />
            ) : events.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
                No decisions yet — queue a task and the spine records every step here.
              </div>
            ) : (
              <ol className="divide-y divide-[#e0ded5]/60">
                {[...events]
                  .sort((a, b) => b.seq - a.seq)
                  .map((event) => (
                    <EventRow key={event.seq} event={event} />
                  ))}
              </ol>
            )}
          </section>

          <section
            aria-label="Outbox"
            className="border border-[#e0ded5] bg-[#fffef8] shadow-[3px_3px_0_var(--paper-shadow)] self-start"
          >
            <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
              Outbox — owed side effects
            </div>
            {outbox.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
                Nothing owed — every post-back that should happen has been delivered.
              </div>
            ) : (
              <ol className="divide-y divide-[#e0ded5]/60">
                {outbox.map((entry) => (
                  <OutboxRow key={entry.id} entry={entry} />
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const KIND_TONE: Record<string, string> = {
  "run.completed": "text-[#146c2e] bg-[#146c2e]/10 border-[#146c2e]/30",
  "run.failed": "text-[#fb2c36] bg-[#fb2c36]/10 border-[#fb2c36]/30",
  "run.cancelled": "text-[#8a5a00] bg-[#f4b400]/15 border-[#f4b400]/40",
  "run.rejected": "text-[#fb2c36] bg-[#fb2c36]/10 border-[#fb2c36]/30",
  "approval.answered": "text-[#1c1cc8] bg-[#0000a8]/10 border-[#0000a8]/30",
  "approval.requested": "text-[#1c1cc8] bg-[#0000a8]/10 border-[#0000a8]/30",
  "side_effect.failed": "text-[#fb2c36] bg-[#fb2c36]/10 border-[#fb2c36]/30",
};

function eventSummary(event: SpineEventWire): string {
  const p = event.payload;
  if (!p) return "";
  if (typeof p.summary === "string") return p.summary;
  if (typeof p.status === "string") return p.status;
  if (typeof p.target === "string") return `${p.effectKind ?? "effect"} → ${p.target}`;
  if (typeof p.error === "string") return p.error;
  if (typeof p.result === "string") return p.result;
  if (p.run && typeof p.run === "object") {
    const run = p.run as Record<string, unknown>;
    return [run.harness, run.codingModel].filter((v) => typeof v === "string").join(" · ");
  }
  return "";
}

function EventRow({ event }: { event: SpineEventWire }): JSX.Element {
  const tone = KIND_TONE[event.kind] ?? "text-[#6a6f63] bg-black/[0.04] border-[#e0ded5]";
  const summary = eventSummary(event);
  return (
    <li className="px-4 py-2.5 flex items-baseline gap-3">
      <span className="font-mono text-[10px] text-[#6a6f63]/70 w-10 shrink-0 tabular-nums">
        #{event.seq}
      </span>
      <span
        className={`text-[10px] font-semibold uppercase tracking-[0.08em] border px-1.5 py-0.5 shrink-0 ${tone}`}
      >
        {event.kind}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-xs text-[#222320] truncate">
          {summary || <span className="text-[#6a6f63]">—</span>}
        </span>
        <span className="block font-mono text-[10px] text-[#6a6f63]/70 truncate">
          {event.runId ? `run ${event.runId.slice(0, 12)}… · ` : ""}
          cmd {event.commandId.slice(0, 12)}
          {event.causationId ? ` · caused by ${event.causationId.slice(0, 12)}` : ""}
        </span>
      </span>
      <time
        className="font-mono text-[10px] text-[#6a6f63]/70 shrink-0 tabular-nums"
        dateTime={new Date(event.at).toISOString()}
      >
        {new Date(event.at).toLocaleTimeString()}
      </time>
    </li>
  );
}

function OutboxRow({ entry }: { entry: OutboxEntryWire }): JSX.Element {
  const tone =
    entry.status === "dispatched"
      ? "text-[#146c2e] bg-[#146c2e]/10 border-[#146c2e]/30"
      : entry.status === "failed"
        ? "text-[#fb2c36] bg-[#fb2c36]/10 border-[#fb2c36]/30"
        : "text-[#8a5a00] bg-[#f4b400]/15 border-[#f4b400]/40";
  return (
    <li className="px-4 py-2.5 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-semibold uppercase tracking-[0.08em] border px-1.5 py-0.5 ${tone}`}>
          {entry.status}
        </span>
        <span className="text-xs font-medium text-[#222320]">{entry.effectKind}</span>
        <span className="font-mono text-[10px] text-[#6a6f63]/70 ml-auto">×{entry.attempts}</span>
      </div>
      <div className="font-mono text-[10px] text-[#6a6f63] truncate">
        {entry.target}
        {entry.summary ? ` — ${entry.summary}` : ""}
      </div>
      {entry.lastError ? (
        <div className="text-[10px] text-[#fb2c36] truncate">{entry.lastError}</div>
      ) : null}
    </li>
  );
}
