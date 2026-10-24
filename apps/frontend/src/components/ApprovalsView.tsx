import { type JSX, useMemo, useState } from "react";
import type { StoredApproval } from "../types";
import type { PendingApproval } from "../ui-helpers";
import { ApprovalCard } from "./ApprovalCard";
import { AuditPanel } from "./AuditPanel";
import { HarnessSessionPanel } from "./HarnessSessionPanel";
import { LoadErrorState } from "./LoadErrorState";
import { EmptyState, PageHeader } from "./surface";
import { DecidedApprovalRow, StoredApprovalCard } from "./WorkspacePanel";

export interface ApprovalsViewProps {
  pendingApprovals: PendingApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (id: string, ok: boolean) => void;
  storedApprovals: StoredApproval[];
  storedDecisions: Record<string, boolean>;
  decidedStoredApprovals: StoredApproval[];
  storedApprovalsError: string | null;
  onDecideStoredApproval: (approval: StoredApproval, ok: boolean) => void;
  orchestratorName?: string | null;
  onRefresh?: () => void;
  reviewAfterPublishById?: Record<string, boolean>;
  /** Poll the live Codex/Claude session. Off unless the shell is showing this page for real. */
  liveHarness?: boolean;
}

type OutcomeFilter = "all" | "approved" | "rejected" | "executed";

export function ApprovalsView({
  pendingApprovals,
  decisions,
  onDecideApproval,
  storedApprovals,
  storedDecisions,
  decidedStoredApprovals,
  storedApprovalsError,
  onDecideStoredApproval,
  orchestratorName,
  onRefresh,
  reviewAfterPublishById,
  liveHarness = false,
}: ApprovalsViewProps): JSX.Element {
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const totalPending = pendingApprovals.length + storedApprovals.length;

  const filteredDecided = useMemo(() => {
    if (outcomeFilter === "all") return decidedStoredApprovals;
    return decidedStoredApprovals.filter((a) => {
      if (outcomeFilter === "rejected") return a.status === "rejected";
      if (outcomeFilter === "executed") return a.execution?.status === "executed";
      if (outcomeFilter === "approved") {
        return a.status === "approved" && a.execution?.status !== "failed";
      }
      return true;
    });
  }, [decidedStoredApprovals, outcomeFilter]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <PageHeader
        title="Approvals"
        detail="Sandbox runs and outbound messages wait here until you approve them."
      >
        <span
          className={
            totalPending > 0
              ? "text-xs font-mono font-bold px-2 py-0.5 border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] bg-[var(--warning-subtle)] text-[var(--warning-fg)]"
              : "text-xs font-mono px-2 py-0.5 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)] border border-[color-mix(in_oklch,var(--success)_30%,transparent)]"
          }
        >
          {totalPending > 0 ? `${totalPending} waiting` : "0 waiting"}
        </span>
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            className="text-xs font-medium text-[var(--fg)] bg-[var(--card)] hover:bg-[var(--secondary)] border border-[var(--border-1)] px-3 py-1.5 transition-colors"
          >
            Refresh
          </button>
        ) : null}
      </PageHeader>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          <HarnessSessionPanel enabled={liveHarness} />
          {storedApprovalsError !== null ? (
            <LoadErrorState
              message={`Approval queue: ${storedApprovalsError}`}
              onRetry={onRefresh ?? (() => {})}
            />
          ) : null}

          {/* Section 1: Pending Approvals */}
          <section aria-labelledby="pending-approvals-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between pb-1 border-b border-[var(--border-1)]">
              <h3
                id="pending-approvals-heading"
                className="text-sm font-semibold text-[var(--fg)] flex items-center gap-2"
              >
                <span>Waiting</span>
                {totalPending > 0 ? (
                  <span className="size-2 rounded-full bg-[var(--warning-fg)]" aria-hidden="true" />
                ) : null}
              </h3>
              <span className="text-xs font-mono text-[var(--muted-foreground-2)]">
                {totalPending} item{totalPending === 1 ? "" : "s"}
              </span>
            </div>

            {totalPending === 0 ? (
              <EmptyState
                title="Nothing waiting"
                detail="New runs and outbound messages pause here until you approve them."
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Chat Tool Approvals */}
                {pendingApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    decided={decisions[approval.approvalId] !== undefined}
                    decision={decisions[approval.approvalId]}
                    onDecideApproval={onDecideApproval}
                    agentName={orchestratorName ?? undefined}
                    reviewAfterPublish={reviewAfterPublishById?.[approval.approvalId]}
                  />
                ))}

                {/* Stored DO Approvals */}
                {storedApprovals.map((approval) => (
                  <StoredApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    decided={storedDecisions[approval.approvalId] !== undefined}
                    decision={storedDecisions[approval.approvalId]}
                    onDecide={onDecideStoredApproval}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Section 2: Recent Decided Outcomes */}
          {decidedStoredApprovals.length > 0 ? (
            <section aria-labelledby="recent-outcomes-heading" className="flex flex-col gap-3">
              <div className="flex items-center justify-between pb-1 border-b border-[var(--border-1)] flex-wrap gap-2">
                <h3 id="recent-outcomes-heading" className="text-sm font-semibold text-[var(--fg)]">
                  Decided
                </h3>
                <div className="flex items-center gap-1 font-mono text-[11px]">
                  {(["all", "approved", "rejected", "executed"] as OutcomeFilter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setOutcomeFilter(f)}
                      aria-pressed={outcomeFilter === f}
                      className={`px-2.5 py-1 border transition-colors capitalize ${
                        outcomeFilter === f
                          ? "border-[var(--primary)] bg-[var(--primary)] text-white font-bold"
                          : "border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {filteredDecided.length === 0 ? (
                <p className="border border-dashed border-[var(--border-1)] bg-[var(--card)] px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
                  No decided actions match the “{outcomeFilter}” filter.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filteredDecided.map((approval) => (
                    <DecidedApprovalRow key={approval.approvalId} approval={approval} />
                  ))}
                </div>
              )}
            </section>
          ) : null}

          <section aria-label="Audit log" className="flex flex-col gap-3">
            <div className="bg-[var(--card)] border border-[var(--border-1)] p-4 shadow-[var(--sh-card)]">
              <AuditPanel />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
