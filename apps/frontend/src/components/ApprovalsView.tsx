import { useState, useMemo, type JSX } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { AuditPanel } from "./AuditPanel";
import {
  StoredApprovalCard,
  DecidedApprovalRow,
} from "./WorkspacePanel";
import type { PendingApproval } from "../ui-helpers";
import type { StoredApproval } from "../types";

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
}: ApprovalsViewProps): JSX.Element {
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const totalPending = pendingApprovals.length + storedApprovals.length;

  const filteredDecided = useMemo(() => {
    if (outcomeFilter === "all") return decidedStoredApprovals;
    return decidedStoredApprovals.filter((a) => {
      if (outcomeFilter === "rejected") return a.status === "rejected";
      if (outcomeFilter === "executed") return a.execution?.status === "executed";
      if (outcomeFilter === "approved") {
        return a.status === "approved" || a.execution?.status !== "failed";
      }
      return true;
    });
  }, [decidedStoredApprovals, outcomeFilter]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      {/* Top Header */}
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Approvals & Decision Center</span>
            {totalPending > 0 ? (
              <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-none bg-[#f99c00] text-white animate-pulse">
                {totalPending} waiting
              </span>
            ) : (
              <span className="text-xs font-mono px-2 py-0.5 rounded-none bg-[#15803d]/10 text-[#15803d] border border-[#15803d]/30">
                0 pending · all clear
              </span>
            )}
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Human-in-the-loop review for sandbox tool calls, outbound communications, and cryptographic audit records.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider font-mono text-[#0000a8]/80 bg-[#0000a8]/10 border border-[#0000a8]/20 px-2 py-1 rounded-none">
            Zero-Trust Boundary
          </span>
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              className="text-xs font-medium text-[#222320] bg-[#fffef8] hover:bg-[#e0ded5] border border-[#e0ded5] px-3 py-1.5 rounded-none transition-colors"
            >
              Refresh
            </button>
          ) : null}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {storedApprovalsError !== null ? (
            <div className="text-xs text-[#fb2c36] bg-[#fb2c36]/10 border border-[#fb2c36]/30 rounded-none p-3.5 flex items-start gap-2">
              <svg className="w-4 h-4 text-[#fb2c36] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>Approval queue sync error: {storedApprovalsError}</span>
            </div>
          ) : null}

          {/* Section 1: Pending Approvals */}
          <section aria-labelledby="pending-approvals-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between pb-1 border-b border-[#e0ded5]">
              <h3 id="pending-approvals-heading" className="text-sm font-semibold text-[#222320] flex items-center gap-2">
                <span>Pending Approvals</span>
                {totalPending > 0 ? (
                  <span className="size-2 rounded-full bg-[#b45309] animate-pulse" />
                ) : null}
              </h3>
              <span className="text-xs font-mono text-[#6a6f63]">
                {totalPending} item{totalPending === 1 ? "" : "s"}
              </span>
            </div>

            {totalPending === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[#e0ded5] rounded-none bg-[#fffef8] text-center p-6">
                <div className="w-10 h-10 rounded-full bg-[#15803d]/10 text-[#15803d] flex items-center justify-center mb-2">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h4 className="text-sm font-semibold text-[#222320]">All Clear</h4>
                <p className="text-xs text-[#6a6f63] max-w-sm mt-0.5">
                  No actions are currently awaiting your approval. Outbound communications and privileged sandbox tasks will pause here when queued.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Chat Tool Approvals */}
                {pendingApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    decided={decisions[approval.approvalId] !== undefined}
                    onDecideApproval={onDecideApproval}
                    agentName={orchestratorName ?? undefined}
                  />
                ))}

                {/* Stored DO Approvals */}
                {storedApprovals.map((approval) => (
                  <StoredApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    decided={storedDecisions[approval.approvalId] !== undefined}
                    onDecide={onDecideStoredApproval}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Section 2: Recent Decided Outcomes */}
          {decidedStoredApprovals.length > 0 ? (
            <section aria-labelledby="recent-outcomes-heading" className="flex flex-col gap-3">
              <div className="flex items-center justify-between pb-1 border-b border-[#e0ded5] flex-wrap gap-2">
                <h3 id="recent-outcomes-heading" className="text-sm font-semibold text-[#222320]">
                  Recent Outcomes & Decided Actions
                </h3>
                <div className="flex items-center gap-1 font-mono text-[11px]">
                  {(["all", "approved", "rejected", "executed"] as OutcomeFilter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setOutcomeFilter(f)}
                      className={`px-2.5 py-1 border transition-colors capitalize ${
                        outcomeFilter === f
                          ? "border-[#0000a8] bg-[#0000a8] text-white font-bold"
                          : "border-[#e0ded5] bg-[#fffef8] text-[#6a6f63] hover:text-[#222320]"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {filteredDecided.map((approval) => (
                  <DecidedApprovalRow key={approval.approvalId} approval={approval} />
                ))}
              </div>
            </section>
          ) : null}

          {/* Section 3: Cryptographic Audit Trail */}
          <section aria-labelledby="audit-trail-heading" className="flex flex-col gap-3">
            <div className="pb-1 border-b border-[#e0ded5]">
              <h3 id="audit-trail-heading" className="text-sm font-semibold text-[#222320]">
                Cryptographic Audit Log (D1 + SHA-256)
              </h3>
            </div>
            <div className="bg-[#fffef8] border border-[#e0ded5] p-4 rounded-none shadow-xs">
              <AuditPanel />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
