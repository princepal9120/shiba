import { type JSX, useCallback, useEffect, useState } from "react";

interface HarnessApproval {
  requestId: string;
  kind: string;
  title: string;
  detail: string;
  decision?: "allow" | "deny";
}

interface HarnessRun {
  sandboxId: string;
  events: { seq: number; type: string; text: string }[];
  diff: string;
  approvals: HarnessApproval[];
}

interface HarnessBoard {
  runs: HarnessRun[];
}

/**
 * Live Codex/Claude session: events, a tool approval, the checkpoint diff,
 * and interrupt. Mounted only when the caller asks — the Approvals page
 * tests stub fetch and must stay quiet when this is off.
 */
export function HarnessSessionPanel({
  enabled = false,
}: {
  enabled?: boolean;
}): JSX.Element | null {
  const [board, setBoard] = useState<HarnessBoard | null>(null);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/computers/harness");
      if (response.status === 404) {
        setHidden(true);
        return;
      }
      if (!response.ok) return;
      setBoard((await response.json()) as HarnessBoard);
    } catch {
      // The next tick retries. A blip must not clear a decision the operator is reading.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [enabled, load]);

  if (!enabled || hidden || board === null) return null;
  const run = board.runs?.[0];
  if (!run) return null;
  const waiting = run.approvals.filter((approval) => approval.decision === undefined);

  const decide = (requestId: string, decision: "allow" | "deny") => {
    void fetch("/api/computers/harness/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sandboxId: run.sandboxId, requestId, decision }),
    }).then(() => load());
  };

  return (
    <section
      aria-label="Live agent session"
      className="flex flex-col gap-3 border border-[var(--border-1)] bg-[var(--card)] p-4 shadow-[var(--sh-card)]"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Live session</h3>
        <button
          type="button"
          className="text-xs font-medium text-[var(--warning-fg)] bg-[var(--warning-subtle)] border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] px-3 py-1.5"
          onClick={() => {
            void fetch("/api/computers/harness/control", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sandboxId: run.sandboxId, interrupt: true }),
            });
          }}
        >
          Interrupt
        </button>
      </div>
      {waiting.map((approval) => (
        <div
          key={approval.requestId}
          className="border border-[var(--border-1)] bg-[var(--panel)] p-3 flex flex-col gap-2"
        >
          <p className="text-sm text-[var(--fg)]">{approval.title}</p>
          {approval.detail ? (
            <p className="text-xs font-mono text-[var(--muted-foreground-2)] whitespace-pre-wrap">
              {approval.detail}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs font-medium bg-[var(--card)] border border-[var(--border-1)] px-3 py-1.5"
              onClick={() => decide(approval.requestId, "allow")}
            >
              Allow
            </button>
            <button
              type="button"
              className="text-xs font-medium bg-[var(--card)] border border-[var(--border-1)] px-3 py-1.5"
              onClick={() => decide(approval.requestId, "deny")}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
      {run.events.length > 0 ? (
        <ol className="text-xs font-mono text-[var(--fg)] flex flex-col gap-1 max-h-40 overflow-y-auto">
          {run.events.slice(-12).map((event) => (
            <li key={event.seq}>{event.text}</li>
          ))}
        </ol>
      ) : null}
      {run.diff ? (
        <pre
          data-testid="harness-diff"
          className="text-xs font-mono overflow-x-auto whitespace-pre-wrap bg-[var(--panel)] border border-[var(--border-1)] p-3"
        >
          {run.diff}
        </pre>
      ) : null}
    </section>
  );
}
