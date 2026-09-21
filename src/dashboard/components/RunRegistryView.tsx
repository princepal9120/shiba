import { useState, useMemo, type JSX } from "react";
import { DiffViewer } from "./DiffViewer";
import { formatTimeAgo, parseRepoName, statusLabel } from "../ui-helpers";
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
    pending: "text-[#f59e0b] border-[#f59e0b]/40 bg-[#f59e0b]/10",
    running: "text-[#2dd4bf] border-[#0B9F95]/40 bg-[#0B9F95]/10",
    completed: "text-[#4cc38a] border-[#4cc38a]/30 bg-[#4cc38a]/10",
    error: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
    aborted: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
    cancelled: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
  };

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (filter === "active" && run.status !== "running" && run.status !== "pending") return false;
      if (filter === "completed" && run.status !== "completed") return false;
      if (filter === "error" && run.status !== "error" && run.status !== "aborted" && run.status !== "cancelled") return false;
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
    const error = runs.filter((r) => r.status === "error" || r.status === "aborted" || r.status === "cancelled").length;
    // Outcome metrics (Factory-style): success rate on terminal runs, median
    // wall-clock for completed runs, and how many asked for a PR.
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
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-black text-[#e6edf3]">
      {/* Top Header */}
      <div className="border-b border-[#1e2530] bg-[#0a0c10]/95 backdrop-blur-md px-4 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[#e6edf3] flex items-center gap-2">
            <span>Run Registry & Workspaces</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-black border border-[#1e2530] text-[#8b98a9]">
              {stats.total} total
            </span>
          </h2>
          <p className="text-xs text-[#8b98a9]">
            History of all delegated coding tasks, sandbox containers, and generated pull requests.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onRefresh}
            className="text-xs bg-black hover:bg-[#1e2530] border border-[#1e2530] text-[#e6edf3] font-medium py-1.5 px-3 rounded-lg transition-colors flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5 text-[#8b98a9]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>Refresh</span>
          </button>

          {runs.length > 0 ? (
            <button
              type="button"
              onClick={onClearHistory}
              className="text-xs bg-transparent hover:bg-[#f06666]/10 text-[#f06666] border border-[#f06666]/30 font-medium py-1.5 px-3 rounded-lg transition-colors"
            >
              Clear History
            </button>
          ) : null}
        </div>
      </div>

      {/* Stats Cards & Filters */}
      <div className="p-4 lg:p-8 flex-1 overflow-y-auto flex flex-col gap-6">
        {/* Quick Stats Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <div className="bg-[#0a0c10] border border-[#1e2530] rounded-xl p-3.5 shadow-sm flex flex-col gap-1">
            <span className="text-[11px] font-mono text-[#8b98a9] uppercase">Total Runs</span>
            <span className="text-xl font-bold text-[#e6edf3] font-mono">{stats.total}</span>
          </div>
          <div className="bg-[#0a0c10] border border-[#1e2530] rounded-xl p-3.5 flex flex-col gap-1">
            <span className="text-[11px] font-mono text-[#2dd4bf] uppercase">Active Now</span>
            <span className="text-xl font-bold text-[#2dd4bf] font-mono">{stats.active}</span>
          </div>
          <div className="bg-[#0a0c10] border border-[#1e2530] rounded-xl p-3.5 flex flex-col gap-1">
            <span className="text-[11px] font-mono text-[#4cc38a] uppercase">Completed</span>
            <span className="text-xl font-bold text-[#4cc38a] font-mono">{stats.completed}</span>
          </div>
          <div className="bg-[#0a0c10] border border-[#1e2530] rounded-xl p-3.5 flex flex-col gap-1">
            <span className="text-[11px] font-mono text-[#f06666] uppercase">Failed / Cancelled</span>
            <span className="text-xl font-bold text-[#f06666] font-mono">{stats.error}</span>
          </div>
          <div className="bg-[#0a0c10] border border-[#1e2530] rounded-xl p-3.5 flex flex-col gap-1">
            <span className="text-[11px] font-mono text-[#8b98a9] uppercase">Success Rate</span>
            <span className="text-xl font-bold text-[#e6edf3] font-mono">
              {stats.successRate === null ? "—" : `${stats.successRate}%`}
            </span>
          </div>
          <div className="bg-[#0a0c10] border border-[#1e2530] rounded-xl p-3.5 flex flex-col gap-1">
            <span className="text-[11px] font-mono text-[#8b98a9] uppercase">Median Cycle</span>
            <span className="text-xl font-bold text-[#e6edf3] font-mono">
              {stats.medianMs === null
                ? "—"
                : stats.medianMs < 60_000
                  ? `${Math.round(stats.medianMs / 1000)}s`
                  : `${Math.round(stats.medianMs / 60_000)}m`}
            </span>
          </div>
          <div className="bg-[#0a0c10] border border-[#1e2530] rounded-xl p-3.5 flex flex-col gap-1">
            <span className="text-[11px] font-mono text-[#8b98a9] uppercase">PRs Requested</span>
            <span className="text-xl font-bold text-[#e6edf3] font-mono">{stats.prRequested}</span>
          </div>
        </div>

        {/* Filter Controls & Search */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-[#0a0c10] p-3 rounded-xl border border-[#1e2530]">
          <div className="flex items-center gap-1 bg-[#11141b] p-1 rounded-lg border border-[#1e2530] text-xs">
            {(["all", "active", "completed", "error"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilter(tab)}
                className={`px-3 py-1 rounded-md transition-colors capitalize ${
                  filter === tab
                    ? "bg-[#1e2530] text-[#e6edf3] font-semibold shadow-sm"
                    : "text-[#8b98a9] hover:text-[#e6edf3]"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="relative flex-1 max-w-xs">
            <input
              type="text"
              aria-label="Search runs"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search repository or task..."
              className="w-full bg-black text-xs font-mono text-[#e6edf3] border border-[#1e2530] rounded-lg pl-8 pr-3 py-1.5 focus:outline-none focus:border-[#0B9F95] placeholder:text-[#8b98a9]/50"
            />
            <svg className="w-3.5 h-3.5 text-[#8b98a9] absolute left-2.5 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Runs List */}
        {filteredRuns.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 border border-dashed border-[#1e2530] rounded-xl bg-[#0a0c10]/40 p-6 text-center">
            <p className="text-[#8b98a9] text-sm mb-1 font-medium">No runs matching your criteria</p>
            <p className="text-xs text-[#8b98a9]/70">
              Submit a task from the Task Console to execute code in an isolated Cloudflare Sandbox.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredRuns.map((run) => {
              const isExpanded = expandedRunId === run.runId;
              const sColor = statusColors[run.status] || "text-[#8b98a9] border-[#1e2530] bg-[#0a0c10]";
              const repoName = parseRepoName(run.repoUrl);

              return (
                <div
                  key={run.runId}
                  className="border border-[#1e2530] rounded-xl bg-[#0a0c10] overflow-hidden transition-all hover:border-[#2c3545]"
                >
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-label={`Toggle details for run ${run.runId}`}
                    onClick={() => setExpandedRunId(isExpanded ? null : run.runId)}
                    className="w-full text-left p-4 flex items-center justify-between cursor-pointer hover:bg-[#1e2530]/30 select-none gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <svg
                        className={`w-4 h-4 text-[#8b98a9] transform transition-transform shrink-0 ${isExpanded ? "rotate-90 text-[#2dd4bf]" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-[#e6edf3] font-semibold truncate">
                            {repoName}
                          </span>
                          <span className="text-[11px] text-[#8b98a9] font-mono">
                            {formatTimeAgo(run.createdAt)}
                          </span>
                        </div>
                        <p className="text-xs text-[#8b98a9] truncate max-w-xl font-sans mt-0.5">
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
                    <div className="p-4 border-t border-[#1e2530] bg-black/40 flex flex-col gap-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-[#8b98a9]">
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          <span>Sandbox: <span className="text-[#4f9cf0]">{run.sandboxId}</span></span>
                          <span>Branch: <span className="text-[#e6edf3]">{run.baseBranch}</span></span>
                          {run.publishPullRequest ? (
                            <span className="text-[#2dd4bf] font-semibold">✓ PR Requested</span>
                          ) : null}
                        </div>

                        {/* Direct Inspect VM Button */}
                        <button
                          type="button"
                          onClick={() => onInspectVM(run.runId)}
                          className="bg-[#0B9F95] hover:bg-[#2dd4bf] text-black font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                          <span>Inspect Virtual Machine</span>
                        </button>
                      </div>

                      {/* Full Task Description */}
                      <pre className="font-sans text-xs text-[#e6edf3] whitespace-pre-wrap break-words bg-[#0a0c10] p-3 rounded-lg border border-[#1e2530] leading-relaxed">
                        {run.task}
                      </pre>

                      {/* Summary */}
                      {run.summary ? (
                        <div className="border border-[#1e2530] rounded-lg p-3 bg-[#0a0c10]">
                          <span className="text-[11px] font-mono uppercase text-[#2dd4bf] font-bold block mb-1">
                            Result Summary
                          </span>
                          <pre className="font-mono text-xs text-[#e6edf3] whitespace-pre-wrap break-words max-h-48 overflow-auto">
                            {run.summary}
                          </pre>
                        </div>
                      ) : null}

                      {/* Error */}
                      {run.error ? (
                        <div className="border border-[#f06666]/30 rounded-lg p-3 bg-[#f06666]/10 text-xs text-[#f06666]">
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
                      <div className="flex items-center gap-2 pt-1 border-t border-[#1e2530]/80">
                        {(run.status === "pending" || run.status === "running") ? (
                          <button
                            type="button"
                            className="text-xs bg-transparent border border-[#f06666] hover:bg-[#f06666]/10 text-[#f06666] font-medium py-1.5 px-3 rounded-md transition-colors"
                            onClick={() => onCancelRun(run.runId)}
                          >
                            Cancel Run
                          </button>
                        ) : null}

                        <button
                          type="button"
                          className="text-xs bg-black hover:bg-[#1e2530] border border-[#1e2530] text-[#8b98a9] hover:text-[#e6edf3] font-medium py-1.5 px-3 rounded-md transition-colors"
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
  );
}
