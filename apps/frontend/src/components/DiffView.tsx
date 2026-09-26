import { useState, useMemo, type JSX } from "react";
import { DiffViewer } from "./DiffViewer";
import { formatTimeAgo, parseRepoName, extractCompletedDiff, statusLabel, statusChipClass } from "../ui-helpers";
import type { VMRun } from "./VMInspector";

export interface DiffViewProps {
  runs: VMRun[];
  selectedRunId?: string | null;
  onSelectRun?: (runId: string) => void;
  onInspectVM?: (runId: string) => void;
}

export function DiffView({
  runs,
  selectedRunId,
  onSelectRun,
  onInspectVM,
}: DiffViewProps): JSX.Element {
  const [internalSelectedId, setInternalSelectedId] = useState<string>(
    selectedRunId || runs[0]?.runId || ""
  );

  const activeRunId = selectedRunId || internalSelectedId;

  const activeRun = useMemo(
    () => runs.find((r) => r.runId === activeRunId) || runs[0] || null,
    [runs, activeRunId]
  );

  const activeDiff = useMemo(() => {
    if (!activeRun) return null;
    return extractCompletedDiff(activeRun) ?? activeRun.diff ?? null;
  }, [activeRun]);

  const runsWithDiff = useMemo(
    () => runs.filter((r) => Boolean(extractCompletedDiff(r) ?? r.diff)),
    [runs]
  );

  const handleSelect = (runId: string) => {
    setInternalSelectedId(runId);
    onSelectRun?.(runId);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      {/* Top Header */}
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Diff & Patch Inspector</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-none bg-[#fffef8] border border-[#e0ded5] text-[#6a6f63]">
              {runsWithDiff.length} with diffs / {runs.length} total
            </span>
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Review source code modifications, patch hunks, and git diffs across delegated agent runs.
          </p>
        </div>

        {/* Run Selector */}
        {runs.length > 0 ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-[#6a6f63]">Active Run:</span>
            <select
              aria-label="Select run for diff inspection"
              value={activeRun?.runId ?? ""}
              onChange={(e) => handleSelect(e.target.value)}
              className="text-xs font-mono bg-[#fffef8] border border-[#e0ded5] rounded-none px-2.5 py-1.5 text-[#222320] focus:border-[#0000a8] focus:outline-none max-w-xs truncate"
            >
              {runs.map((r) => {
                const hasDiff = Boolean(extractCompletedDiff(r) ?? r.diff);
                return (
                  <option key={r.runId} value={r.runId}>
                    {hasDiff ? "● " : "○ "}
                    {parseRepoName(r.repoUrl)} · {r.runId.slice(0, 8)} ({statusLabel(r.status)})
                  </option>
                );
              })}
            </select>

            {onInspectVM && activeRun ? (
              <button
                type="button"
                onClick={() => onInspectVM(activeRun.runId)}
                className="text-xs font-medium text-[#1c1cc8] bg-[#0000a8]/10 hover:bg-[#0000a8]/15 border border-[#0000a8]/20 px-2.5 py-1.5 rounded-none transition-colors"
              >
                Open in VM
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        {!activeRun ? (
          <div className="flex flex-col items-center justify-center py-16 border border-dashed border-[#e0ded5] rounded-none bg-[#fffef8] max-w-3xl mx-auto p-8 text-center">
            <div className="w-12 h-12 rounded-none bg-[#0000a8]/10 border border-[#0000a8]/20 text-[#0000a8] flex items-center justify-center mb-3">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7v10M8 7a2 2 0 100-4 2 2 0 000 4zm0 10a2 2 0 100 4 2 2 0 000-4zm8-6v6m0-6a2 2 0 100-4 2 2 0 000 4zm0 6a2 2 0 100 4 2 2 0 000-4z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-[#222320] mb-1">No Task Runs Found</h3>
            <p className="text-xs text-[#6a6f63] max-w-md">
              Start a new task from the Tasks view. Once the agent modifies code inside the sandbox container, git diffs will appear here.
            </p>
          </div>
        ) : activeDiff ? (
          <div className="max-w-6xl mx-auto flex flex-col gap-4">
            {/* Run summary strip */}
            <div className="bg-[#fffef8] border border-[#e0ded5] p-4 rounded-none flex items-center justify-between gap-4 flex-wrap shadow-xs">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-semibold text-sm text-[#222320]">
                    {parseRepoName(activeRun.repoUrl)}
                  </span>
                  <span className="font-mono text-xs text-[#6a6f63]">
                    branch: {activeRun.baseBranch || "main"}
                  </span>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider border rounded-none px-2 py-0.5 ${statusChipClass(
                      activeRun.status
                    )}`}
                  >
                    {statusLabel(activeRun.status)}
                  </span>
                </div>
                <p className="text-xs text-[#6a6f63] truncate max-w-2xl">
                  {activeRun.task}
                </p>
              </div>

              <div className="text-right text-xs font-mono text-[#6a6f63]">
                <div>Run ID: {activeRun.runId}</div>
                <div>{formatTimeAgo(activeRun.createdAt)}</div>
              </div>
            </div>

            {/* Diff Viewer Card */}
            <div className="bg-[#fffef8] border border-[#e0ded5] rounded-none p-4 shadow-xs">
              <DiffViewer diff={activeDiff} runId={activeRun.runId} />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 border border-dashed border-[#e0ded5] rounded-none bg-[#fffef8] max-w-3xl mx-auto p-8 text-center">
            <div className="w-12 h-12 rounded-none bg-[#f6f4ed] border border-[#e0ded5] text-[#6a6f63] flex items-center justify-center mb-3">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-[#222320] mb-1">
              No Git Diff Recorded for Run {activeRun.runId.slice(0, 8)}
            </h3>
            <p className="text-xs text-[#6a6f63] max-w-md mb-4">
              Status: <span className="font-semibold">{statusLabel(activeRun.status)}</span>. This run may still be in progress, finished without file mutations, or encountered an early error before code was written.
            </p>
            {onInspectVM ? (
              <button
                type="button"
                onClick={() => onInspectVM(activeRun.runId)}
                className="text-xs font-medium text-[#1c1cc8] bg-[#0000a8]/10 hover:bg-[#0000a8]/15 border border-[#0000a8]/20 px-3 py-1.5 rounded-none transition-colors"
              >
                Inspect Sandbox Environment in VM
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
