/**
 * WorkspacePanel — right-hand Devin-style pane (~400px).
 * Tabs: Runs | VM | Diff | Approvals. Collapses to a 40px icon rail.
 * Below lg the expanded panel becomes a fixed right drawer so the
 * conversation keeps full width on small screens.
 */
import { useMemo, useState, type JSX } from "react";
import { DiffViewer } from "./DiffViewer";
import { VMInspector, type VMRun } from "./VMInspector";
import { ApprovalCard } from "./ApprovalCard";
import { InboxTab } from "./InboxTab";
import { MemoryTab } from "./MemoryTab";
import {
  formatTimeAgo,
  parseRepoName,
  extractCompletedDiff,
  statusChipClass,
  statusLabel,
  type PendingApproval,
} from "../ui-helpers";
import type { RetainedRun, ToolRunRecord } from "../types";

export type WorkspaceTab = "runs" | "inbox" | "memory" | "vm" | "diff" | "approvals";

export interface WorkspacePanelProps {
  toolRuns: ToolRunRecord[];
  retainedRuns: RetainedRun[];
  /** Merged tool + retained runs (VMRun shape) for the VM and Diff tabs. */
  vmRuns: VMRun[];
  pendingApprovals: PendingApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (id: string, ok: boolean) => void;
  onRefreshRuns: () => void;
  onInspectVM: (runId: string) => void;
  onCancelRun?: (runId: string) => void;
  onReuseParams?: (run: RetainedRun) => void;
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Controlled active tab; falls back to internal state when omitted. */
  tab?: WorkspaceTab;
  onTabChange?: (tab: WorkspaceTab) => void;
}

type RunsFilter = "all" | "active" | "completed";

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

function matchesFilter(status: string, filter: RunsFilter): boolean {
  if (filter === "active") return isActiveStatus(status);
  if (filter === "completed") return status === "completed";
  return true;
}

function isActiveStatus(status: string): boolean {
  return status === "running" || status === "pending";
}

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "inbox", label: "Inbox" },
  { id: "memory", label: "Memory" },
  { id: "vm", label: "VM" },
  { id: "diff", label: "Diff" },
  { id: "approvals", label: "Approvals" },
];

const GHOST_BUTTON =
  "text-[11px] bg-transparent hover:bg-[#fffef8] border border-[#e0ded5] hover:border-[#d3d2c8] text-[#6a6f63] hover:text-[#222320] font-medium py-1 px-2.5 rounded-md transition-colors";
const TEAL_BUTTON =
  "text-[11px] bg-[#dceafa]/60 hover:bg-[#dceafa] border border-[#9cbce2]/60 text-[#1c1cc8] font-medium py-1 px-2.5 rounded-md transition-colors";
const DANGER_BUTTON =
  "text-[11px] bg-transparent hover:bg-[#fb2c36]/10 border border-[#fb2c36]/50 text-[#fb2c36] font-medium py-1 px-2.5 rounded-md transition-colors";

export function WorkspacePanel({
  toolRuns,
  retainedRuns,
  vmRuns,
  pendingApprovals,
  decisions,
  onDecideApproval,
  onRefreshRuns,
  onInspectVM,
  onCancelRun,
  onReuseParams,
  selectedRunId,
  onSelectRun,
  collapsed,
  onToggleCollapsed,
  tab: controlledTab,
  onTabChange,
}: WorkspacePanelProps): JSX.Element {
  const [internalTab, setInternalTab] = useState<WorkspaceTab>("runs");
  const tab = controlledTab ?? internalTab;
  const setTab = (next: WorkspaceTab) => {
    setInternalTab(next);
    onTabChange?.(next);
  };
  const [runsFilter, setRunsFilter] = useState<RunsFilter>("all");

  const filteredToolRuns = useMemo(
    () => toolRuns.filter((run) => matchesFilter(run.status, runsFilter)),
    [toolRuns, runsFilter],
  );
  const filteredRetainedRuns = useMemo(
    () => retainedRuns.filter((run) => matchesFilter(run.status, runsFilter)),
    [retainedRuns, runsFilter],
  );

  // VM/Diff tabs resolve against the merged run list so live delegated runs
  // are inspectable before the orchestrator retains them.
  const selectedRun = useMemo(
    () => vmRuns.find((run) => run.runId === selectedRunId) ?? null,
    [vmRuns, selectedRunId],
  );
  const selectedDiff = selectedRun
    ? extractCompletedDiff(selectedRun) ?? selectedRun.diff ?? null
    : null;

  const badgeCounts: Record<WorkspaceTab, number | null> = {
    runs: toolRuns.length + retainedRuns.length,
    inbox: null,
    memory: null,
    vm: null,
    diff: null,
    approvals: pendingApprovals.length,
  };

  // Collapsed: 40px icon rail — always rendered, even below lg.
  if (collapsed) {
    return (
      <aside className="w-10 shrink-0 border-l border-[#e0ded5] bg-[#f1efe6] flex flex-col items-center py-2 gap-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand workspace panel"
          title="Expand workspace panel"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-[#6a6f63] hover:text-[#222320] hover:bg-[#fffef8] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {pendingApprovals.length > 0 ? (
          <span
            className="w-2 h-2 rounded-full bg-[#b45309] animate-pulse"
            title={`${pendingApprovals.length} pending approval(s)`}
          />
        ) : null}
      </aside>
    );
  }

  return (
    <aside className="w-[400px] max-w-[88vw] shrink-0 border-l border-[#e0ded5] bg-[#f1efe6] flex flex-col min-h-0 fixed top-14 bottom-0 right-0 z-40 shadow-2xl lg:static lg:z-auto lg:shadow-none">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-0 border-b border-[#e0ded5]">
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
                  ? "text-[#222320] border-[#0000a8] bg-[#fffef8]"
                  : "text-[#6a6f63] border-transparent hover:text-[#222320] hover:bg-[#fffef8]"
              }`}
            >
              {t.label}
              {count !== null && count > 0 ? (
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${
                    t.id === "approvals"
                      ? "text-[#b45309] border-[#b45309]/40 bg-[#b45309]/10"
                      : "text-[#6a6f63] border-[#e0ded5] bg-[#fffef8]"
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
          className="w-7 h-7 mb-1 rounded-lg flex items-center justify-center text-[#6a6f63] hover:text-[#222320] hover:bg-[#fffef8] transition-colors"
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
                        ? "text-[#222320] border-[#0000a8]/50 bg-[#0000a8]/10"
                        : "text-[#6a6f63] border-[#e0ded5] hover:border-[#d3d2c8] hover:text-[#222320]"
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
                className="text-[11px] text-[#6a6f63] hover:text-[#222320] border border-[#e0ded5] hover:border-[#d3d2c8] rounded-md px-2 py-1 transition-colors flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh
              </button>
            </div>

            {filteredToolRuns.length === 0 && filteredRetainedRuns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#e0ded5] rounded-xl bg-[#f6f4ed] px-4 text-center">
                <p className="text-[#6a6f63] text-xs">No runs. Approved tasks appear here while they execute.</p>
              </div>
            ) : null}

            {filteredToolRuns.length > 0 ? (
              <ol className="flex flex-col gap-3">
                {filteredToolRuns.map((run) => {
                  const completedDiff = extractCompletedDiff(run);
                  const selected = run.runId === selectedRunId;
                  return (
                    <li
                      key={run.runId}
                      className={`border rounded-xl p-3 bg-[#f6f4ed] transition-colors ${
                        selected ? "border-[#0000a8]/50" : "border-[#e0ded5]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectRun(run.runId)}
                          className="font-mono text-[11px] text-[#222320] break-all text-left hover:text-[#1c1cc8] transition-colors min-w-0"
                        >
                          {run.runId}
                        </button>
                        <span className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 ${statusChipClass(run.status)}`}>
                          {statusLabel(run.status)}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#6a6f63] font-mono flex flex-wrap gap-x-2 mb-2">
                        {run.agentType ? <span>{run.agentType}</span> : null}
                        {run.parentToolCallId ? <span>· tool call {run.parentToolCallId}</span> : null}
                      </div>
                      {run.parts.length > 0 ? (
                        <pre className="font-mono text-[11px] text-[#6a6f63] bg-[#fffef8] p-2.5 rounded-lg border border-[#e0ded5] max-h-40 overflow-auto whitespace-pre-wrap break-words mb-2">
                          {run.parts.map(runPartText).join("\n")}
                        </pre>
                      ) : null}
                      {run.summary ? (
                        <pre className="font-mono text-[11px] text-[#222320] bg-[#fffef8] p-2.5 rounded-lg border border-[#e0ded5] max-h-40 overflow-auto whitespace-pre-wrap break-words mb-2">
                          {run.summary}
                        </pre>
                      ) : null}
                      {run.error ? (
                        <p className="text-[11px] text-[#fb2c36] bg-[#fb2c36]/10 p-2.5 rounded-lg border border-[#fb2c36]/20 mb-2">
                          {run.error}
                        </p>
                      ) : null}
                      {completedDiff ? <DiffViewer diff={completedDiff} runId={run.runId} /> : null}
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <button
                          type="button"
                          className={TEAL_BUTTON}
                          onClick={() => onInspectVM(run.runId)}
                        >
                          Inspect VM
                        </button>
                        {onCancelRun && isActiveStatus(run.status) ? (
                          <button
                            type="button"
                            className={DANGER_BUTTON}
                            onClick={() => onCancelRun(run.runId)}
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}

            {filteredRetainedRuns.length > 0 ? (
              <>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#6a6f63] border-t border-[#e0ded5] pt-3 flex items-center justify-between">
                  <span>Retained Runs</span>
                  <span className="font-mono lowercase">{filteredRetainedRuns.length} total</span>
                </h4>
                <ol className="flex flex-col gap-2">
                  {filteredRetainedRuns.map((run) => {
                    const selected = run.runId === selectedRunId;
                    return (
                      <li
                        key={run.runId}
                        className={`border rounded-xl bg-[#f6f4ed] overflow-hidden hover:border-[#d3d2c8] transition-colors ${
                          selected ? "border-[#0000a8]/50" : "border-[#e0ded5]"
                        }`}
                      >
                        <details className="group">
                          <summary
                            className="flex items-center justify-between p-3 cursor-pointer hover:bg-[#fffef8] transition-colors select-none"
                            aria-label={`${run.task} — ${run.repoUrl} — ${run.status}`}
                          >
                            <div className="flex items-center gap-2 overflow-hidden">
                              <svg className="w-3.5 h-3.5 text-[#6a6f63] transform group-open:rotate-90 transition-transform shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                              <span className="font-mono text-[11px] text-[#222320] truncate font-medium">
                                {parseRepoName(run.repoUrl)}
                              </span>
                              <span className="text-[10px] text-[#6a6f63] font-mono shrink-0">
                                {formatTimeAgo(run.createdAt)}
                              </span>
                            </div>
                            <span className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 ml-2 ${statusChipClass(run.status)}`}>
                              {statusLabel(run.status)}
                            </span>
                          </summary>
                          <div className="p-3 pt-0 border-t border-[#e0ded5]/60 mt-1 flex flex-col gap-2">
                            <div className="text-[10px] text-[#6a6f63] font-mono flex flex-wrap gap-x-3 gap-y-1">
                              <span>Sandbox: {run.sandboxId}</span>
                              <span>Branch: {run.baseBranch}</span>
                              {run.publishPullRequest ? <span className="text-[#0000a8]">· pull request requested</span> : null}
                            </div>
                            <pre className="text-xs text-[#222320] whitespace-pre-wrap break-words bg-[#f6f4ed] p-2.5 rounded-lg border border-[#e0ded5]/60">
                              {run.task}
                            </pre>
                            {run.summary ? (
                              <pre className="font-mono text-[11px] text-[#222320] bg-[#fffef8] p-2.5 rounded-lg border border-[#e0ded5] whitespace-pre-wrap break-words max-h-40 overflow-auto">
                                {run.summary}
                              </pre>
                            ) : null}
                            {run.error ? (
                              <p className="text-[11px] text-[#fb2c36] bg-[#fb2c36]/10 p-2.5 rounded-lg border border-[#fb2c36]/20">
                                {run.error}
                              </p>
                            ) : null}
                            {run.status === "completed" && run.diff ? (
                              <DiffViewer diff={run.diff} runId={run.runId} />
                            ) : null}
                            <div className="flex items-center gap-2 pt-1 flex-wrap">
                              <button
                                type="button"
                                className={GHOST_BUTTON}
                                onClick={() => onSelectRun(run.runId)}
                              >
                                Select
                              </button>
                              <button
                                type="button"
                                className={TEAL_BUTTON}
                                onClick={() => onInspectVM(run.runId)}
                              >
                                Inspect VM
                              </button>
                              {onReuseParams ? (
                                <button
                                  type="button"
                                  className={GHOST_BUTTON}
                                  onClick={() => onReuseParams(run)}
                                >
                                  Reuse params
                                </button>
                              ) : null}
                              {onCancelRun && isActiveStatus(run.status) ? (
                                <button
                                  type="button"
                                  className={DANGER_BUTTON}
                                  onClick={() => onCancelRun(run.runId)}
                                >
                                  Cancel
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </details>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : null}
          </div>
        ) : null}

        {tab === "inbox" ? <InboxTab onOpenApprovals={() => setTab("approvals")} /> : null}

        {tab === "memory" ? <MemoryTab /> : null}

        {tab === "vm" ? (
          <VMInspector runs={vmRuns} selectedRunId={selectedRunId} onSelectRun={onSelectRun} />
        ) : null}

        {tab === "diff" ? (
          selectedRun && selectedDiff ? (
            <DiffViewer diff={selectedDiff} runId={selectedRun.runId} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#e0ded5] rounded-xl bg-[#f6f4ed] px-4 text-center">
              <p className="text-[#6a6f63] text-xs">
                {selectedRunId
                  ? "No diff available for the selected run."
                  : "Select a completed run to view its diff."}
              </p>
            </div>
          )
        ) : null}

        {tab === "approvals" ? (
          pendingApprovals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#e0ded5] rounded-xl bg-[#f6f4ed] px-4 text-center">
              <p className="text-[#6a6f63] text-xs">No pending approvals.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3" role="group" aria-label="Pending approvals">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#b45309] flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#b45309] animate-pulse" />
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
