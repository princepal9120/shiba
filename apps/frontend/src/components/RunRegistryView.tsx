import { useState, useMemo, type JSX } from "react";
import { DiffViewer } from "./DiffViewer";
import { ERROR_FAMILY_STATUSES, formatTimeAgo, parseRepoName, statusLabel } from "../ui-helpers";
import type { RetainedRun } from "../types";

export type { RetainedRun };

export interface RunRegistryViewProps {
  runs: RetainedRun[];
  onInspectVM: (runId: string) => void;
  onReuseParams: (run: RetainedRun) => void;
  onCancelRun: (runId: string) => void;
  onClearHistory: () => void;
  onRefresh: () => void;
}

export function RunRegistryView({
  runs,
  onInspectVM,
  onReuseParams,
  onCancelRun,
  onClearHistory,
  onRefresh,
}: RunRegistryViewProps): JSX.Element {
  const [filter, setFilter] = useState<"all" | "active" | "completed" | "error">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(runs[0]?.runId || null);

  const statusColors: Record<string, string> = {
    pending: "text-amber-700 border-amber-200 bg-amber-50",
    running: "text-blue-700 border-blue-200 bg-blue-50",
    completed: "text-emerald-700 border-emerald-200 bg-emerald-50",
    error: "text-rose-700 border-rose-200 bg-rose-50",
    aborted: "text-rose-700 border-rose-200 bg-rose-50",
    cancelled: "text-rose-700 border-rose-200 bg-rose-50",
    unknown: "text-[#b45309] border-[#b45309]/30 bg-[#b45309]/10",
  };

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (filter === "active" && run.status !== "running" && run.status !== "pending") return false;
      if (filter === "completed" && run.status !== "completed") return false;
      if (filter === "error" && !ERROR_FAMILY_STATUSES.has(run.status)) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          run.task.toLowerCase().includes(q) ||
          run.repoUrl.toLowerCase().includes(q) ||
          run.sandboxId.toLowerCase().includes(q) ||
          run.runId.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [runs, filter, searchQuery]);

  const stats = useMemo(() => {
    const total = runs.length;
    const active = runs.filter((r) => r.status === "running" || r.status === "pending").length;
    const completedRuns = runs.filter((r) => r.status === "completed");
    const completed = completedRuns.length;
    const error = runs.filter((r) => ERROR_FAMILY_STATUSES.has(r.status)).length;
    const terminal = completed + error;
    const successRate = terminal > 0 ? Math.round((completed / terminal) * 100) : null;
    const durations = completedRuns
      .map((r) => r.updatedAt - r.createdAt)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const medianMs = durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : null;
    const prRequested = runs.filter((r) => r.publishPullRequest).length;
    return { total, active, completed, error, successRate, medianMs, prRequested };
  }, [runs]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f8fafc] text-slate-900">
      {/* Top Header */}
      <div className="border-b border-slate-200 bg-white/95 backdrop-blur-md px-6 lg:px-8 py-5 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
              <span>Run Registry & Workspaces</span>
            </h2>
            <span className="bg-slate-100 text-slate-600 text-[11px] font-bold px-2.5 py-0.5 rounded-full border border-slate-200">
              {stats.total} TOTAL
            </span>
          </div>
          <p className="text-xs text-slate-500 max-w-xl">
            History of all delegated coding tasks, sandbox containers, and generated pull requests.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onRefresh}
            className="text-xs bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-semibold py-2 px-3.5 rounded-lg transition-all shadow-sm flex items-center gap-2"
          >
            <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>Refresh</span>
          </button>

          {runs.length > 0 ? (
            <button
              type="button"
              onClick={onClearHistory}
              className="text-xs bg-transparent hover:bg-rose-50 text-rose-600 border border-rose-200 font-semibold py-2 px-3.5 rounded-lg transition-colors"
            >
              Clear History
            </button>
          ) : null}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="p-6 lg:p-8 flex-1 overflow-y-auto flex flex-col gap-6">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3.5">
          {/* Total Runs */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center text-slate-500 border border-slate-100">
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Total Runs</span>
            </div>
            <span className="text-2xl font-bold text-slate-900 tracking-tight">{stats.total}</span>
          </div>

          {/* Active Now */}
          <div className="bg-white p-4 rounded-xl border border-blue-100 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md stat-card-glow-blue flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100">
                <svg className="size-3.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <span className="text-[11px] font-bold text-blue-600 uppercase tracking-wider">Active Now</span>
            </div>
            <span className="text-2xl font-bold text-blue-600 tracking-tight">{stats.active}</span>
          </div>

          {/* Completed */}
          <div className="bg-white p-4 rounded-xl border border-emerald-100 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md stat-card-glow-green flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 border border-emerald-100">
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <span className="text-[11px] font-bold text-emerald-600 uppercase tracking-wider">Completed</span>
            </div>
            <span className="text-2xl font-bold text-emerald-600 tracking-tight">{stats.completed}</span>
          </div>

          {/* Failed / Cancelled */}
          <div className="bg-white p-4 rounded-xl border border-rose-100 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md stat-card-glow-red flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-rose-50 flex items-center justify-center text-rose-600 border border-rose-100">
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <span className="text-[11px] font-bold text-rose-600 uppercase tracking-wider">Failed</span>
            </div>
            <span className="text-2xl font-bold text-rose-600 tracking-tight">{stats.error}</span>
          </div>

          {/* Success Rate */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center text-slate-500 border border-slate-100">
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </div>
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Success Rate</span>
            </div>
            <span className="text-2xl font-bold text-slate-900 tracking-tight">
              {stats.successRate === null ? "—" : `${stats.successRate}%`}
            </span>
          </div>

          {/* Median Cycle */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center text-slate-500 border border-slate-100">
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Median Cycle</span>
            </div>
            <span className="text-2xl font-bold text-slate-900 tracking-tight">
              {stats.medianMs === null
                ? "—"
                : stats.medianMs < 60_000
                  ? `${Math.round(stats.medianMs / 1000)}s`
                  : `${Math.round(stats.medianMs / 60_000)}m`}
            </span>
          </div>

          {/* PRs Requested */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center text-slate-500 border border-slate-100">
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2" />
                </svg>
              </div>
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">PRs Requested</span>
            </div>
            <span className="text-2xl font-bold text-slate-900 tracking-tight">{stats.prRequested}</span>
          </div>
        </div>

        {/* Content Table Container */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[480px]">
          {/* Controls bar */}
          <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/60">
            <div className="flex bg-white border border-slate-200 p-1 rounded-lg shadow-2xs">
              {(["all", "active", "completed", "error"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setFilter(tab)}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-all capitalize ${
                    filter === tab
                      ? "bg-slate-900 text-white shadow-xs"
                      : "text-slate-500 hover:text-slate-900"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="relative flex-1 max-w-sm">
              <svg className="size-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                aria-label="Search runs"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search repository or task..."
                className="w-full bg-white text-xs text-slate-800 border border-slate-200 rounded-lg pl-9 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 placeholder:text-slate-400 shadow-2xs"
              />
            </div>
          </div>

          {/* Runs List or Empty State */}
          {filteredRuns.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
              <div className="mb-5 relative">
                <div className="w-20 h-20 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-blue-600 shadow-sm">
                  <svg className="size-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                </div>
                <div className="absolute -bottom-1.5 -right-1.5 w-8 h-8 bg-white border-2 border-slate-100 rounded-full flex items-center justify-center text-blue-600 shadow-xs">
                  <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                </div>
              </div>
              <h3 className="text-base font-bold text-slate-900 mb-1.5">
                No runs. Approved tasks appear here while they execute.
              </h3>
              <p className="text-slate-500 text-xs max-w-sm mb-6 leading-relaxed">
                Submit a task from the Task Console to execute code in an isolated Cloudflare Sandbox and see live progress.
              </p>
            </div>
          ) : (
            <div className="p-4 flex flex-col gap-3">
              {filteredRuns.map((run) => {
                const isExpanded = expandedRunId === run.runId;
                const sColor = statusColors[run.status] || "text-slate-600 border-slate-200 bg-slate-50";
                const repoName = parseRepoName(run.repoUrl);

                return (
                  <div
                    key={run.runId}
                    className="border border-slate-200 rounded-xl bg-white overflow-hidden transition-all hover:border-slate-300 shadow-2xs"
                  >
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={`Toggle details for run ${run.runId}`}
                      onClick={() => setExpandedRunId(isExpanded ? null : run.runId)}
                      className="w-full text-left p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50/70 select-none gap-3"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <svg
                          className={`w-4 h-4 text-slate-400 transform transition-transform shrink-0 ${isExpanded ? "rotate-90 text-blue-600" : ""}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="font-semibold text-xs text-slate-900 truncate">
                              {repoName}
                            </span>
                            <span className="text-[11px] text-slate-400 font-mono">
                              {formatTimeAgo(run.createdAt)}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 truncate max-w-xl font-sans">
                            {run.task}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <span className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2.5 py-0.5 ${sColor}`}>
                          {statusLabel(run.status)}
                        </span>
                      </div>
                    </button>

                    {/* Expanded Run Detail Body */}
                    {isExpanded ? (
                      <div className="p-4 border-t border-slate-100 bg-slate-50/60 flex flex-col gap-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-slate-500">
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            <span>Sandbox: <span className="text-blue-600 font-semibold">{run.sandboxId}</span></span>
                            <span>Branch: <span className="text-slate-800">{run.baseBranch}</span></span>
                            {run.publishPullRequest ? (
                              <span className="text-blue-600 font-semibold">✓ PR Requested</span>
                            ) : null}
                          </div>

                          {/* Direct Inspect VM Button */}
                          <button
                            type="button"
                            onClick={() => onInspectVM(run.runId)}
                            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shadow-sm shadow-blue-200"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                            <span>Inspect Virtual Machine</span>
                          </button>
                        </div>

                        {/* Full Task Description */}
                        <pre className="font-sans text-xs text-slate-800 whitespace-pre-wrap break-words bg-white p-3 rounded-lg border border-slate-200 leading-relaxed shadow-2xs">
                          {run.task}
                        </pre>

                        {/* Summary */}
                        {run.summary ? (
                          <div className="border border-slate-200 rounded-lg p-3 bg-white shadow-2xs">
                            <span className="text-[11px] font-mono uppercase text-blue-600 font-bold block mb-1">
                              Result Summary
                            </span>
                            <pre className="font-mono text-xs text-slate-800 whitespace-pre-wrap break-words max-h-48 overflow-auto">
                              {run.summary}
                            </pre>
                          </div>
                        ) : null}

                        {/* Error */}
                        {run.error ? (
                          <div className="border border-rose-200 rounded-lg p-3 bg-rose-50 text-xs text-rose-700">
                            {run.error}
                          </div>
                        ) : null}

                        {/* Diff Preview */}
                        {run.diff ? (
                          <div className="mt-1">
                            <DiffViewer diff={run.diff} runId={run.runId} />
                          </div>
                        ) : null}

                        {/* Action Bar */}
                        <div className="flex items-center gap-2 pt-2 border-t border-slate-200/80">
                          {(run.status === "pending" || run.status === "running") ? (
                            <button
                              type="button"
                              className="text-xs bg-transparent border border-rose-300 hover:bg-rose-50 text-rose-600 font-semibold py-1.5 px-3 rounded-md transition-colors"
                              onClick={() => onCancelRun(run.runId)}
                            >
                              Cancel Run
                            </button>
                          ) : null}

                          <button
                            type="button"
                            className="text-xs bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 hover:text-slate-900 font-semibold py-1.5 px-3 rounded-md transition-colors shadow-2xs"
                            onClick={() => onReuseParams(run)}
                          >
                            Reuse Parameters
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

