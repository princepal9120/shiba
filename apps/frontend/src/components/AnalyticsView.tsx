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
import {
  useUsageReport,
  type UsageDayWire,
  type UsageGroupWire,
  type UsageReportWire,
} from "../live-status";
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
  sessionId,
  sessionApiAvailable,
}: {
  runs: RetainedRun[];
  error?: string | null;
  onNavigate?: (view: AppNavView) => void;
  sessionId: string;
  sessionApiAvailable: boolean;
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

          <UsageSection sessionId={sessionId} sessionApiAvailable={sessionApiAvailable} />

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

/** Compact token count — an absent field renders "—", never a fabricated zero. */
function tokenCount(n: number | undefined): string {
  return n === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function usdCost(n: number | undefined): string {
  if (n === undefined) return "—";
  return `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

function tokenTotalLabel(input: number | undefined, output: number | undefined): string {
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${tokenCount(input)} in`);
  if (output !== undefined) parts.push(`${tokenCount(output)} out`);
  return parts.length > 0 ? parts.join(" / ") : "—";
}

/** Sum a day's worth of reports; a field appears only if some day carried it. */
function usageTotals(days: UsageDayWire[]): { inputTokens?: number; outputTokens?: number; costUsd?: number } {
  const totals: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
  for (const day of days) {
    if (day.inputTokens !== undefined) totals.inputTokens = (totals.inputTokens ?? 0) + day.inputTokens;
    if (day.outputTokens !== undefined) totals.outputTokens = (totals.outputTokens ?? 0) + day.outputTokens;
    if (day.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + day.costUsd;
  }
  return totals;
}

/** Merge per-day groups across the window into one row per harness/provider/role. */
function mergeUsageGroups(days: UsageDayWire[]): UsageGroupWire[] {
  const merged = new Map<string, UsageGroupWire>();
  for (const day of days) {
    for (const group of day.groups) {
      const key = `${group.harness ?? ""}${group.provider ?? ""}${group.role ?? ""}`;
      const row = merged.get(key) ?? {
        harness: group.harness,
        provider: group.provider,
        role: group.role,
        runs: 0,
      };
      row.runs += group.runs;
      if (group.inputTokens !== undefined) row.inputTokens = (row.inputTokens ?? 0) + group.inputTokens;
      if (group.outputTokens !== undefined) row.outputTokens = (row.outputTokens ?? 0) + group.outputTokens;
      if (group.costUsd !== undefined) row.costUsd = (row.costUsd ?? 0) + group.costUsd;
      merged.set(key, row);
    }
  }
  return [...merged.values()].sort((a, b) => (b.inputTokens ?? 0) - (a.inputTokens ?? 0));
}

/**
 * Token usage & budget — the daily aggregates `GET /api/usage` computes over
 * the retained run store. Buckets are UTC days (the wire says so); every
 * number is only what a harness stream reported, so a run that never emits
 * usage contributes nothing and a field that no run reported stays "—".
 */
function UsageSection({
  sessionId,
  sessionApiAvailable,
}: {
  sessionId: string;
  sessionApiAvailable: boolean;
}): JSX.Element {
  const usage = useUsageReport(sessionId, sessionApiAvailable);
  return (
    <section className="rounded-none border border-[#e0ded5] bg-[#fffef8] shadow-[2px_2px_0_var(--paper-shadow)]">
      <header className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5">
        <div>
          <h3 className="text-xs font-semibold text-[#222320]">Token usage &amp; budget</h3>
          <p className="text-[11px] text-[#6a6f63]">
            Daily harness-reported usage — UTC buckets over the retained run store.
          </p>
        </div>
        {usage.state.kind === "data" || usage.state.kind === "error" ? (
          <button
            type="button"
            onClick={usage.reload}
            className="text-[11px] font-mono font-medium text-[#1c1cc8] transition-colors hover:text-[#0000a8]"
          >
            Refresh →
          </button>
        ) : null}
      </header>
      {usage.state.kind === "loading" ? (
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">Loading usage…</div>
      ) : usage.state.kind === "error" ? (
        <div className="px-4 py-3">
          <LoadErrorState message={usage.state.message} onRetry={usage.reload} />
        </div>
      ) : (
        <UsageReportBody report={usage.state.data} />
      )}
    </section>
  );
}

function UsageReportBody({ report }: { report: UsageReportWire }): JSX.Element {
  // The backend buckets by UTC day — "today" is the same UTC day.
  const todayKey = new Date().toISOString().slice(0, 10);
  const weekStartKey = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekDays = report.days.filter((day) => day.date >= weekStartKey);
  const today = report.days.find((day) => day.date === todayKey);
  const week = usageTotals(weekDays);
  const groups = mergeUsageGroups(weekDays);
  const spentToday = today?.costUsd;
  const budget = report.budgetUsd;
  const spentPct =
    budget !== null && budget > 0 && spentToday !== undefined
      ? Math.min(100, (spentToday / budget) * 100)
      : 0;

  if (report.days.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-xs text-[#6a6f63]">
          No retained run has reported token usage yet. opencode, claude-code, and codex streams carry it;
          devin, grok, cursor, and antigravity runs don&apos;t — their runs keep contributing only run counts.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Tokens · today"
          value={tokenTotalLabel(today?.inputTokens, today?.outputTokens)}
          sub={today !== undefined ? `${today.runs} run${today.runs === 1 ? "" : "s"} reported` : "Nothing reported today"}
        />
        <MetricCard
          label="Tokens · 7 days"
          value={tokenTotalLabel(week.inputTokens, week.outputTokens)}
          sub={`${weekDays.reduce((sum, day) => sum + day.runs, 0)} run${weekDays.reduce((sum, day) => sum + day.runs, 0) === 1 ? "" : "s"} reported`}
        />
        <MetricCard
          label="Cost · today"
          value={usdCost(today?.costUsd)}
          sub="Reported by the harness, not estimated"
        />
        <MetricCard
          label="Cost · 7 days"
          value={usdCost(week.costUsd)}
          sub="Reported by the harness, not estimated"
        />
      </div>

      {budget !== null ? (
        <div className="rounded-none border border-[#e0ded5] bg-[#f6f4ed] px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold text-[#222320]">Daily budget</span>
            <span className="font-mono text-[11px] text-[#6a6f63]">
              {spentToday === undefined ? "no spend reported" : usdCost(spentToday)} of {usdCost(budget)}
            </span>
          </div>
          <div className="mt-2 h-2 border border-[#e0ded5] bg-[#e0ded5]/60">
            <div
              className={`h-full ${spentToday !== undefined && spentToday > budget ? "bg-[#fb2c36]" : "bg-[#1c1cc8]"}`}
              style={{ width: `${spentPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-[#6a6f63]">
            USAGE_BUDGET_USD — today&apos;s reported cost against the configured daily budget.
          </p>
        </div>
      ) : null}

      <div>
        <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
          Per harness · last 7 days
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {groups.length === 0 ? (
            <p className="text-xs text-[#6a6f63]">No usage in the last 7 days.</p>
          ) : (
            groups.map((group) => (
              <div
                key={`${group.harness ?? ""}/${group.provider ?? ""}/${group.role ?? ""}`}
                className="flex items-baseline justify-between gap-3 border-b border-[#e0ded5]/60 pb-2 last:border-b-0"
              >
                <span className="font-mono text-[11px] text-[#222320]">
                  {group.harness ?? "not recorded"}
                  {group.provider !== null ? <span className="text-[#6a6f63]"> · {group.provider}</span> : null}
                  {group.role !== null ? <span className="text-[#6a6f63]"> · {group.role}</span> : null}
                </span>
                <span className="text-right font-mono text-[11px] text-[#6a6f63]">
                  {tokenTotalLabel(group.inputTokens, group.outputTokens)}
                  {group.costUsd !== undefined ? ` · ${usdCost(group.costUsd)}` : ""}
                  {` · ${group.runs} run${group.runs === 1 ? "" : "s"}`}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
