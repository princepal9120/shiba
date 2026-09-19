import { useMemo, useState, type JSX } from "react";
import { DiffViewer } from "./DiffViewer";
import { VMInspector } from "./VMInspector";
import {
  formatTimeAgo,
  parseRepoName,
  type PendingApproval,
} from "../ui-helpers";

export interface RetainedRun {
  runId: string;
  sandboxId: string;
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  status: string;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  error?: string;
  diff?: string;
}

export interface ToolRunPart {
  text?: string;
  delta?: string;
  message?: string;
  body?: string;
  [key: string]: unknown;
}

export interface ToolRunRecord {
  runId: string;
  status: string;
  agentType?: string;
  parentToolCallId?: string;
  parts: ToolRunPart[];
  summary?: string;
  error?: string;
  diff?: string;
  [key: string]: unknown;
}

export type WorkspaceTab = "runs" | "vm" | "diff" | "approvals";

export interface WorkspacePanelProps {
  toolRuns: ToolRunRecord[];
  retainedRuns: RetainedRun[];
  pendingApprovals: PendingApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (id: string, ok: boolean) => void;
  onRefreshRuns: () => void;
  onInspectVM: (runId: string) => void;
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

type RunsFilter = "all" | "active" | "completed";

const STATUS_COLORS: Record<string, string> = {
  completed: "text-[#4cc38a] border-[#4cc38a]/30 bg-[#4cc38a]/10",
  running: "text-[#4f9cf0] border-[#4f9cf0]/30 bg-[#4f9cf0]/10",
  pending: "text-[#c9a227] border-[#c9a227]/30 bg-[#c9a227]/10",
  error: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
  aborted: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
  cancelled: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "text-[#8b98a9] border-[#1e2530] bg-[#0a0c10]";
}

function runPartText(part: unknown): string {
  if (typeof part !== "object" || part === null) return "";
  const typed = part as Record<string, unknown>;
  for (const key of ["text", "delta", "message", "body"]) {
    if (typeof typed[key] === "string") return typed[key] as string;
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

// Same rule as app.tsx: only completed runs surface unified-diff output.
function extractCompletedDiff(run: unknown): string | null {
  if (typeof run !== "object" || run === null) return null;
  const record = run as Record<string, unknown>;
  if (record["status"] !== "completed") return null;
  const direct = record["diff"];
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  const summary = record["summary"];
  if (typeof summary === "string" && summary.includes("diff --git")) {
    return summary.slice(summary.indexOf("diff --git"));
  }
  return null;
}

function matchesFilter(status: string, filter: RunsFilter): boolean {
  if (filter === "active") return status === "running" || status === "pending";
  if (filter === "completed") return status === "completed";
  return true;
}

function ApprovalCard({
  approval,
  decided,
  onDecideApproval,
}: {
  approval: PendingApproval;
  decided: boolean;
  onDecideApproval: (id: string, ok: boolean) => void;
}): JSX.Element {
  return (
    <div className="border border-[#c9a227]/60 bg-[#0a0c10] rounded-xl p-4 shadow-lg shadow-[#c9a227]/5 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono font-bold text-sm text-[#e6edf3] flex items-center gap-2 min-w-0">
          <img
            src="/assets/mascot/pet-logo.png"
            alt="Shiba Guard"
            className="w-5 h-5 rounded-full bg-white object-contain border border-amber-500/50 shrink-0"
          />
          <span className="truncate">{approval.tool}</span>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-bold bg-[#c9a227]/15 border border-[#c9a227]/30 text-[#c9a227] px-2 py-0.5 rounded-full shrink-0">
          Action Required
        </span>
      </div>

      <pre className="whitespace-pre-wrap font-mono text-xs text-[#8b98a9] bg-black p-3 rounded-lg border border-[#1e2530] max-h-56 overflow-auto">
        {typeof approval.input === "string" ? approval.input : JSON.stringify(approval.input, null, 2)}
      </pre>

      <p className="text-xs text-[#8b98a9] leading-relaxed">
        Approving starts an isolated sandbox run. Rejecting stops the tool call.
      </p>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          className="bg-[#4cc38a] hover:bg-[#3ba875] text-[#06121f] font-semibold py-2 px-5 rounded-lg transition-colors disabled:opacity-50 text-sm shadow-sm flex items-center gap-1.5"
          disabled={decided}
          onClick={() => onDecideApproval(approval.approvalId, true)}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          <span>Approve</span>
        </button>
        <button
          type="button"
          className="bg-transparent border border-[#f06666] text-[#f06666] hover:bg-[#f06666]/10 font-semibold py-2 px-5 rounded-lg transition-colors disabled:opacity-50 text-sm flex items-center gap-1.5"
          disabled={decided}
          onClick={() => onDecideApproval(approval.approvalId, false)}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span>Reject</span>
        </button>
      </div>
    </div>
  );
}

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "vm", label: "VM" },
  { id: "diff", label: "Diff" },
  { id: "approvals", label: "Approvals" },
];

export function WorkspacePanel({
  toolRuns,
  retainedRuns,
  pendingApprovals,
  decisions,
  onDecideApproval,
  onRefreshRuns,
  onInspectVM,
  selectedRunId,
  onSelectRun,
  collapsed,
  onToggleCollapsed,
}: WorkspacePanelProps): JSX.Element {
  const [tab, setTab] = useState<WorkspaceTab>("runs");
  const [runsFilter, setRunsFilter] = useState<RunsFilter>("all");

  const filteredToolRuns = useMemo(
    () => toolRuns.filter((run) => matchesFilter(run.status, runsFilter)),
    [toolRuns, runsFilter],
  );
  const filteredRetainedRuns = useMemo(
    () => retainedRuns.filter((run) => matchesFilter(run.status, runsFilter)),
    [retainedRuns, runsFilter],
  );

  const selectedRun = useMemo(
    () => retainedRuns.find((run) => run.runId === selectedRunId) ?? null,
    [retainedRuns, selectedRunId],
  );
  const selectedDiff = selectedRun ? extractCompletedDiff(selectedRun) ?? selectedRun.diff ?? null : null;

  const badgeCounts: Record<WorkspaceTab, number | null> = {
    runs: toolRuns.length + retainedRuns.length,
    vm: null,
    diff: null,
    approvals: pendingApprovals.length,
  };

  // Collapsed: 40px icon rail.
  if (collapsed) {
    return (
      <aside className="w-10 shrink-0 border-l border-[#1e2530] bg-[#0a0c10] flex flex-col items-center py-2 gap-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand workspace panel"
          title="Expand workspace panel"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-[#8b98a9] hover:text-[#e6edf3] hover:bg-[#11141b] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {pendingApprovals.length > 0 ? (
          <span
            className="w-2 h-2 rounded-full bg-[#c9a227] animate-pulse"
            title={`${pendingApprovals.length} pending approval(s)`}
          />
        ) : null}
      </aside>
    );
  }

  return (
    <aside className="w-[400px] shrink-0 border-l border-[#1e2530] bg-[#0a0c10] flex flex-col min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-0 border-b border-[#1e2530]">
        {TABS.map((t) => {
          const active = tab === t.id;
          const count = badgeCounts[t.id];
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`text-xs font-medium px-2.5 py-1.5 rounded-t-lg border-b-2 transition-colors flex items-center gap-1.5 ${
                active
                  ? "text-[#e6edf3] border-[#0B9F95] bg-[#11141b]"
                  : "text-[#8b98a9] border-transparent hover:text-[#e6edf3] hover:bg-[#11141b]"
              }`}
            >
              {t.label}
              {count !== null && count > 0 ? (
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${
                    t.id === "approvals"
                      ? "text-[#c9a227] border-[#c9a227]/40 bg-[#c9a227]/10"
                      : "text-[#8b98a9] border-[#1e2530] bg-black"
                  }`}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Collapse workspace panel"
          title="Collapse workspace panel"
          className="w-7 h-7 mb-1 rounded-lg flex items-center justify-center text-[#8b98a9] hover:text-[#e6edf3] hover:bg-[#11141b] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 min-h-0">
        {tab === "runs" ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {(["all", "active", "completed"] as RunsFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setRunsFilter(f)}
                    className={`text-[11px] font-medium px-2 py-1 rounded-full border transition-colors capitalize ${
                      runsFilter === f
                        ? "text-[#e6edf3] border-[#0B9F95]/50 bg-[#0B9F95]/10"
                        : "text-[#8b98a9] border-[#1e2530] hover:border-[#2c3545] hover:text-[#e6edf3]"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={onRefreshRuns}
                title="Refresh runs"
                className="text-[11px] text-[#8b98a9] hover:text-[#e6edf3] border border-[#1e2530] hover:border-[#2c3545] rounded-md px-2 py-1 transition-colors flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh
              </button>
            </div>

            {filteredToolRuns.length === 0 && filteredRetainedRuns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#1e2530] rounded-xl bg-black/40 px-4 text-center">
                <p className="text-[#8b98a9] text-xs">No runs. Approved tasks appear here while they execute.</p>
              </div>
            ) : null}

            {filteredToolRuns.length > 0 ? (
              <ol className="flex flex-col gap-3">
                {filteredToolRuns.map((run) => {
                  const completedDiff = extractCompletedDiff(run);
                  return (
                    <li key={run.runId} className="border border-[#1e2530] rounded-xl p-3 bg-black/40">
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectRun(run.runId)}
                          className="font-mono text-[11px] text-[#e6edf3] break-all text-left hover:text-[#2dd4bf] transition-colors min-w-0"
                        >
                          {run.runId}
                        </button>
                        <span className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 ${statusColor(run.status)}`}>
                          {run.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#8b98a9] font-mono flex flex-wrap gap-x-2 mb-2">
                        {run.agentType ? <span>{run.agentType}</span> : null}
                        {run.parentToolCallId ? <span>· tool call {run.parentToolCallId}</span> : null}
                      </div>
                      {run.parts.length > 0 ? (
                        <pre className="font-mono text-[11px] text-[#8b98a9] bg-black p-2.5 rounded-lg border border-[#1e2530] max-h-40 overflow-auto whitespace-pre-wrap break-words mb-2">
                          {run.parts.map(runPartText).join("\n")}
                        </pre>
                      ) : null}
                      {run.summary ? (
                        <pre className="font-mono text-[11px] text-[#e6edf3] bg-black p-2.5 rounded-lg border border-[#1e2530] max-h-40 overflow-auto whitespace-pre-wrap break-words mb-2">
                          {run.summary}
                        </pre>
                      ) : null}
                      {run.error ? (
                        <p className="text-[11px] text-[#f06666] bg-[#f06666]/10 p-2.5 rounded-lg border border-[#f06666]/20 mb-2">
                          {run.error}
                        </p>
                      ) : null}
                      {completedDiff ? <DiffViewer diff={completedDiff} runId={run.runId} /> : null}
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          type="button"
                          className="text-[11px] bg-teal-950/60 hover:bg-teal-900 border border-teal-800/60 text-teal-300 font-medium py-1 px-2.5 rounded-md transition-colors"
                          onClick={() => onInspectVM(run.runId)}
                        >
                          Inspect VM
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}

            {filteredRetainedRuns.length > 0 ? (
              <>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#8b98a9] border-t border-[#1e2530] pt-3 flex items-center justify-between">
                  <span>Retained Runs</span>
                  <span className="font-mono lowercase">{filteredRetainedRuns.length} total</span>
                </h4>
                <ol className="flex flex-col gap-2">
                  {filteredRetainedRuns.map((run) => (
                    <li key={run.runId} className="border border-[#1e2530] rounded-xl bg-black/40 overflow-hidden hover:border-[#2c3545] transition-colors">
                      <details className="group">
                        <summary
                          className="flex items-center justify-between p-3 cursor-pointer hover:bg-[#11141b] transition-colors select-none"
                          aria-label={`${run.task} — ${run.repoUrl} — ${run.status}`}
                        >
                          <div className="flex items-center gap-2 overflow-hidden">
                            <svg className="w-3.5 h-3.5 text-[#8b98a9] transform group-open:rotate-90 transition-transform shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                onSelectRun(run.runId);
                              }}
                              className="font-mono text-[11px] text-[#e6edf3] truncate font-medium hover:text-[#2dd4bf] transition-colors"
                            >
                              {parseRepoName(run.repoUrl)}
                            </button>
                            <span className="text-[10px] text-[#8b98a9] font-mono shrink-0">
                              {formatTimeAgo(run.createdAt)}
                            </span>
                          </div>
                          <span className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 ml-2 ${statusColor(run.status)}`}>
                            {run.status}
                          </span>
                        </summary>
                        <div className="p-3 pt-0 border-t border-[#1e2530]/60 mt-1 flex flex-col gap-2">
                          <div className="text-[10px] text-[#8b98a9] font-mono flex flex-wrap gap-x-3 gap-y-1">
                            <span>Sandbox: {run.sandboxId}</span>
                            <span>Branch: {run.baseBranch}</span>
                            {run.publishPullRequest ? <span className="text-teal-400">· pull request requested</span> : null}
                          </div>
                          <pre className="text-xs text-[#e6edf3] whitespace-pre-wrap break-words bg-black/40 p-2.5 rounded-lg border border-[#1e2530]/60">
                            {run.task}
                          </pre>
                          {run.summary ? (
                            <pre className="font-mono text-[11px] text-[#e6edf3] bg-black p-2.5 rounded-lg border border-[#1e2530] whitespace-pre-wrap break-words max-h-40 overflow-auto">
                              {run.summary}
                            </pre>
                          ) : null}
                          {run.error ? (
                            <p className="text-[11px] text-[#f06666] bg-[#f06666]/10 p-2.5 rounded-lg border border-[#f06666]/20">
                              {run.error}
                            </p>
                          ) : null}
                          {run.status === "completed" && run.diff ? (
                            <DiffViewer diff={run.diff} runId={run.runId} />
                          ) : null}
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              type="button"
                              className="text-[11px] bg-teal-950/60 hover:bg-teal-900 border border-teal-800/60 text-teal-300 font-medium py-1 px-2.5 rounded-md transition-colors"
                              onClick={() => onInspectVM(run.runId)}
                            >
                              Inspect VM
                            </button>
                          </div>
                        </div>
                      </details>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
          </div>
        ) : null}

        {tab === "vm" ? (
          <VMInspector runs={retainedRuns} selectedRunId={selectedRunId} onSelectRun={onSelectRun} />
        ) : null}

        {tab === "diff" ? (
          selectedRun && selectedDiff ? (
            <DiffViewer diff={selectedDiff} runId={selectedRun.runId} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#1e2530] rounded-xl bg-black/40 px-4 text-center">
              <p className="text-[#8b98a9] text-xs">
                {selectedRunId
                  ? "No diff available for the selected run."
                  : "Select a completed run to view its diff."}
              </p>
            </div>
          )
        ) : null}

        {tab === "approvals" ? (
          pendingApprovals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#1e2530] rounded-xl bg-black/40 px-4 text-center">
              <p className="text-[#8b98a9] text-xs">No pending approvals.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3" role="group" aria-label="Pending approvals">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#c9a227] flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#c9a227] animate-pulse" />
                Waiting for your approval
              </h4>
              {pendingApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  decided={decisions[approval.approvalId] !== undefined}
                  onDecideApproval={onDecideApproval}
                />
              ))}
            </div>
          )
        ) : null}
      </div>
    </aside>
  );
}
