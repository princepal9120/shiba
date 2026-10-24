import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { LoaderCircle } from "lucide-react";
import type { FindingTriage, ReviewFinding, ReviewRound } from "@shiba/shared";
import { LoadErrorState } from "./LoadErrorState";
import { CardSkeleton } from "./surface";

const TRIAGE_OPTIONS: FindingTriage[] = ["open", "resolved", "irrelevant"];

type FetchState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; round: ReviewRound | null };

export interface ReviewFindingsProps {
  threadId: string;
  /** Frozen at approval — controls empty copy when no round exists yet. */
  reviewAfterPublish?: boolean;
}

/** One row per finding from GET /pr/review; triage is persisted on the orchestrator DO. */
export function ReviewFindings({
  threadId,
  reviewAfterPublish = false,
}: ReviewFindingsProps): JSX.Element | null {
  const [fetchState, setFetchState] = useState<FetchState>({ kind: "loading" });
  const fetchStateRef = useRef(fetchState);
  fetchStateRef.current = fetchState;
  const [retryPending, setRetryPending] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setFetchState({ kind: "loading" });
    void fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/pr/review`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Review fetch failed (${response.status})`);
        }
        const body = (await response.json()) as { round?: ReviewRound | null };
        return { kind: "ready" as const, round: body.round ?? null };
      })
      .then((next) => {
        if (!cancelled) setFetchState(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFetchState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    return load();
  }, [load]);

  const setTriage = (findingId: string, triage: FindingTriage) => {
    const current = fetchStateRef.current;
    const previous = current.kind === "ready" ? current.round : null;
    if (previous) {
      setFetchState({
        kind: "ready",
        round: {
          ...previous,
          findings: (previous.findings ?? []).map((finding) =>
            finding.id === findingId ? { ...finding, triage } : finding,
          ),
        },
      });
    }
    void fetch(
      `/api/v1/threads/${encodeURIComponent(threadId)}/pr/review/findings/${encodeURIComponent(findingId)}/triage`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ triage }) },
    )
      .then(async (response) => {
        if (!response.ok) {
          if (previous) setFetchState({ kind: "ready", round: previous });
          return;
        }
        const body = (await response.json()) as { round?: ReviewRound };
        if (body.round) setFetchState({ kind: "ready", round: body.round });
      })
      .catch(() => {
        if (previous) setFetchState({ kind: "ready", round: previous });
      });
  };

  const retryReview = () => {
    setRetryPending(true);
    void fetch(`/api/v1/threads/${encodeURIComponent(threadId)}/pr/review/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .finally(() => {
        setRetryPending(false);
        load();
      });
  };

  const panelClass =
    "border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--card)] p-3 flex flex-col gap-2";

  if (!reviewAfterPublish && fetchState.kind === "ready" && !fetchState.round) {
    return null;
  }

  if (fetchState.kind === "loading") {
    return (
      <section data-testid="review-findings" data-state="loading" className={panelClass} aria-busy="true">
        <CardSkeleton label="Loading review findings" />
      </section>
    );
  }

  if (fetchState.kind === "error") {
    return (
      <section data-testid="review-findings" data-state="error" className={panelClass}>
        <LoadErrorState message={`Review: ${fetchState.message}`} onRetry={load} />
      </section>
    );
  }

  const round = fetchState.round;
  if (!round) {
    return (
      <section data-testid="review-findings" data-state="waiting" className={panelClass}>
        <h3 className="text-sm font-semibold text-[var(--fg)]">Review findings</h3>
        <p className="text-xs text-[var(--muted-foreground-2)]">
          {reviewAfterPublish
            ? "Read-only review starts after the pull request opens. No round yet."
            : "No review round for this thread."}
        </p>
      </section>
    );
  }

  const findings: ReviewFinding[] = round.findings ?? [];
  const inFlight = round.status === "queued" || round.status === "running";

  return (
    <section data-testid="review-findings" data-state="ready" data-round-status={round.status} className={panelClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Review findings</h3>
        <span className="text-[10px] uppercase tracking-wider font-bold border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)]">
          {round.status}
        </span>
      </div>
      {inFlight ? (
        <p className="text-xs text-[var(--fg)] flex items-center gap-2">
          <LoaderCircle className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" aria-hidden="true" />
          Reviewer run in progress…
        </p>
      ) : null}
      {round.status === "failed" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[var(--destructive)] break-words" role="alert">
            {round.error ?? "Review round failed."}
          </p>
          <button
            type="button"
            data-testid="review-retry"
            disabled={retryPending}
            onClick={retryReview}
            className="text-xs font-semibold text-[var(--primary)] border border-[var(--primary)]/40 bg-[var(--primary-soft)] rounded-[var(--radius-button)] px-3 py-1.5 self-start disabled:opacity-50"
          >
            {retryPending ? "Retrying…" : "Retry review"}
          </button>
        </div>
      ) : null}
      {round.summary ? <p className="text-xs text-[var(--muted-foreground-2)]">{round.summary}</p> : null}
      {findings.length === 0 && !inFlight && round.status !== "failed" ? (
        <p className="text-xs text-[var(--muted-foreground-2)]">No findings in this round.</p>
      ) : null}
      {findings.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {findings.map((finding) => (
            <li key={finding.id} data-finding-id={finding.id} data-triage={finding.triage} className="text-xs text-[var(--fg)] flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider font-bold border border-[var(--border-1)] px-1.5 py-0.5 rounded-[var(--radius-button)]">{finding.severity}</span>
              <span className="font-mono text-[var(--muted-foreground-2)]">{finding.path}:{finding.line}</span>
              <span>{finding.title}</span>
              <label className="flex items-center gap-1 text-[10px] text-[var(--muted-foreground-2)]">
                Triage
                <select
                  className="text-[10px] border border-[var(--border-1)] rounded px-1 py-0.5 bg-[var(--card)]"
                  value={finding.triage}
                  aria-label={`Triage for ${finding.title}`}
                  onChange={(event) => setTriage(finding.id, event.target.value as FindingTriage)}
                >
                  {TRIAGE_OPTIONS.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
