/**
 * AnalyticsView — Costs-style usage page over the retained run registry
 * (`GET /api/runs` → DelegatedRun[]). Every metric is computed from fields
 * that actually exist on the run record; anything the backend does not
 * track (token counts, USD cost) is an honest empty state, never fabricated.
 */
import { useMemo, type JSX } from "react";
import type { AppNavView } from "./AppNavRail";
import { LoadErrorState } from "./LoadErrorState";
import { ToneChip } from "./ToneChip";
import type { RetainedRun } from "../types";
import {
  ERROR_FAMILY_STATUSES,
  formatTimeAgo,
  parseRepoName,
  statusChipClass,
  statusLabel,
} from "../ui-helpers";

function isTerminal(status: string): boolean {
  return status === "completed" || ERROR_FAMILY_STATUSES.has(status);
}

function runDurationMs(run: RetainedRun): number | null {
  if (!isTerminal(run.status) || run.createdAt <= 0 || run.updatedAt <= run.createdAt) return null;
  return run.updatedAt - run.createdAt;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }): JSX.Element {
  return (
    <div className="rounded-none border border-[#e0ded5] bg-[#fffef8] p-4 shadow-[2px_2px_0_var(--paper-shadow)]">
      <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">{label}</p>
      <p className="mt-1.5 font-display text-2xl text-[#222320]">{value}</p>
      <p className="mt-0.5 text-[11px] text-[#6a6f63]">{sub}</p>
    </div>
  );
}

/** Count breakdown rendered as labeled meter rows (no chart lib in this repo). */
function BreakdownCard({
  title,
  hint,
  rows,
  empty,
}: {
  title: string;
  hint: string;
  rows: { label: string; count: number }[];
  empty: string;
}): JSX.Element {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="rounded-none border border-[#e0ded5] bg-[#fffef8] shadow-[2px_2px_0_var(--paper-shadow)]">
      <header className="border-b border-[#e0ded5] px-4 py-2.5">
        <h3 className="text-xs font-semibold text-[#222320]">{title}</h3>
        <p className="text-[11px] text-[#6a6f63]">{hint}</p>
      </header>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">{empty}</div>
      ) : (
        <div className="flex flex-col gap-2 px-4 py-3">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-3">
              <span className="w-36 shrink-0 truncate font-mono text-[11px] text-[#222320]" title={row.label}>
                {row.label}
              </span>
              <div className="h-2.5 flex-1 bg-[#e0ded5]/60">
                <div
                  className="h-full bg-[#0000a8]"
                  style={{ width: `${Math.round((row.count / max) * 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right font-mono text-[11px] text-[#6a6f63]">{row.count}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function countsBy(runs: RetainedRun[], key: (run: RetainedRun) => string): { label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const run of runs) {
    const label = key(run);
    map.set(label, (map.get(label) ?? 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

export function AnalyticsView({
  runs,
  error,
  onNavigate,
}: {
  runs: RetainedRun[];
  error?: string | null;
  onNavigate?: (view: AppNavView) => void;
}): JSX.Element {
  const stats = useMemo(() => {
    const terminal = runs.filter((run) => isTerminal(run.status));
    const completed = runs.filter((run) => run.status === "completed");
    const failed = runs.filter((run) => ERROR_FAMILY_STATUSES.has(run.status));
    const active = runs.filter((run) => run.status === "pending" || run.status === "running");
    const durations = runs.map(runDurationMs).filter((ms): ms is number => ms !== null);
    const avg = durations.length > 0 ? durations.reduce((sum, ms) => sum + ms, 0) / durations.length : null;
    const prs = runs.filter((run) => typeof run.pullUrl === "string" && run.pullUrl !== "");
    return {
      total: runs.length,
      terminal: terminal.length,
      completed: completed.length,
      failed: failed.length,
      active: active.length,
      avgDurationMs: avg,
      prs: prs.length,
    };
  }, [runs]);

  const byHarness = useMemo(
    () => countsBy(runs, (run) => run.route?.harness ?? "not recorded"),
    [runs],
  );
  const byModel = useMemo(
    () => countsBy(runs, (run) => run.route?.modelId ?? "not recorded"),
    [runs],
  );
  const byRuntime = useMemo(
    () => countsBy(runs, (run) => run.runtime ?? "sandbox"),
    [runs],
  );
  const byRepo = useMemo(
    () => countsBy(runs, (run) => parseRepoName(run.repoUrl)).slice(0, 6),
    [runs],
  );

  const tableRuns = useMemo(
    () => [...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50),
    [runs],
  );

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Analytics</span>
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Usage and outcomes across the retained run registry — computed from what runs actually record.
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {error ? <LoadErrorState message={error} onRetry={() => window.location.reload()} /> : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="Total runs" value={String(stats.total)} sub="Retained registry records" />
            <MetricCard
              label="Completed"
              value={String(stats.completed)}
              sub={stats.terminal > 0 ? `${Math.round((stats.completed / stats.terminal) * 100)}% of terminal runs` : "No terminal runs yet"}
            />
            <MetricCard
              label="Error family"
              value={String(stats.failed)}
              sub={stats.terminal > 0 ? `${Math.round((stats.failed / stats.terminal) * 100)}% of terminal runs` : "error · aborted · cancelled · unknown"}
            />
            <MetricCard label="Active now" value={String(stats.active)} sub="Pending + running" />
            <MetricCard
              label="Avg duration"
              value={stats.avgDurationMs !== null ? formatDuration(stats.avgDurationMs) : "—"}
              sub="Terminal runs, updatedAt − createdAt"
            />
            <MetricCard label="PRs opened" value={String(stats.prs)} sub="Runs carrying a pullUrl" />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BreakdownCard
              title="Runs by harness"
              hint="run.route.harness — absent on records predating route freezing"
              rows={byHarness}
              empty="No runs recorded."
            />
            <BreakdownCard
              title="Runs by model"
              hint="run.route.modelId — the frozen, approval-gated route"
              rows={byModel}
              empty="No runs recorded."
            />
            <BreakdownCard
              title="Runtime"
              hint="sandbox vs local (T51) dispatch"
              rows={byRuntime}
              empty="No runs recorded."
            />
            <BreakdownCard
              title="Top repositories"
              hint="By run count across the registry"
              rows={byRepo}
              empty="No runs recorded."
            />
          </div>

          {/* Honest gap: DelegatedRun carries no token or USD fields. */}
          <section className="rounded-none border border-dashed border-[#d3d2c8] bg-[#fffef8]/60 px-4 py-4">
            <h3 className="text-xs font-semibold text-[#222320]">Token usage &amp; cost</h3>
            <p className="mt-1 text-xs leading-relaxed text-[#6a6f63]">
              Not tracked — run records (<span className="font-mono">DelegatedRun</span>) carry no token counts or
              USD cost fields. Billing for this deployment is container-seconds at the Cloudflare Containers layer;
              provider spend lives at AI Gateway, which the Worker does not introspect.
            </p>
          </section>

          <section className="rounded-none border border-[#e0ded5] bg-[#fffef8] shadow-[2px_2px_0_var(--paper-shadow)]">
            <header className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5">
              <div>
                <h3 className="text-xs font-semibold text-[#222320]">Runs</h3>
                <p className="text-[11px] text-[#6a6f63]">
                  {tableRuns.length === runs.length
                    ? `${runs.length} run${runs.length === 1 ? "" : "s"}`
                    : `Latest ${tableRuns.length} of ${runs.length}`}
                </p>
              </div>
              {onNavigate ? (
                <button
                  type="button"
                  onClick={() => onNavigate("runs")}
                  className="text-[11px] font-mono font-medium text-[#1c1cc8] transition-colors hover:text-[#0000a8]"
                >
                  Open registry →
                </button>
              ) : null}
            </header>
            {tableRuns.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-[#6a6f63]">No runs yet — nothing to measure.</p>
                {onNavigate ? (
                  <button
                    type="button"
                    onClick={() => onNavigate("tasks")}
                    className="mt-3 text-[13px] font-semibold text-[#0000a8] transition-colors hover:text-[#1c1cc8]"
                  >
                    Delegate your first task →
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-[#e0ded5] text-[10px] font-mono uppercase tracking-[0.1em] text-[#6a6f63]">
                      <th className="px-4 py-2 font-semibold">Run</th>
                      <th className="px-4 py-2 font-semibold">Repository</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 font-semibold">Harness</th>
                      <th className="px-4 py-2 font-semibold">Runtime</th>
                      <th className="px-4 py-2 font-semibold">Duration</th>
                      <th className="px-4 py-2 font-semibold">Created</th>
                      <th className="px-4 py-2 font-semibold">PR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRuns.map((run) => {
                      const duration = runDurationMs(run);
                      return (
                        <tr key={run.runId} className="border-b border-[#e0ded5]/60 last:border-b-0">
                          <td className="px-4 py-2">
                            <div className="font-mono text-[11px] text-[#222320]">{run.runId.slice(0, 8)}</div>
                            <div className="max-w-56 truncate text-[11px] text-[#6a6f63]" title={run.task}>
                              {run.task}
                            </div>
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[#6a6f63]">{parseRepoName(run.repoUrl)}</td>
                          <td className="px-4 py-2">
                            <span className={`inline-block rounded-none border px-2 py-0.5 text-[11px] font-medium ${statusChipClass(run.status)}`}>
                              {statusLabel(run.status)}
                            </span>
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[#6a6f63]">{run.route?.harness ?? "—"}</td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[#6a6f63]">{run.runtime ?? "sandbox"}</td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[#6a6f63]">
                            {duration !== null ? formatDuration(duration) : run.status === "running" || run.status === "pending" ? "in flight" : "—"}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-[#6a6f63]">{formatTimeAgo(run.createdAt)}</td>
                          <td className="px-4 py-2">
                            {run.pullUrl ? (
                              <a
                                href={run.pullUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-[11px] font-medium text-[#1c1cc8] hover:text-[#0000a8]"
                              >
                                open →
                              </a>
                            ) : (
                              <span className="font-mono text-[11px] text-[#6a6f63]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-[11px] text-[#6a6f63]">
            Statuses roll up the registry vocabulary — <ToneChip tone="ok" label="completed" /> counts toward the
            success rate; error, aborted, cancelled, and unknown count toward the error family.
          </p>
        </div>
      </div>
    </div>
  );
}
