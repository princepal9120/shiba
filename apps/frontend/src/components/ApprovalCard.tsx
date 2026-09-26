// ApprovalCard — the sacred approval gate UI. waiting-approval tool calls
// surface this card with Approve/Reject wired to chat.addToolApprovalResponse
// via the parent's onDecideApproval. Never auto-approve; never hide.
import type { JSX } from "react";
import type { PendingApproval } from "../ui-helpers";
import { Tooltip } from "./Tooltip";

export interface ApprovalCardProps {
  approval: PendingApproval;
  decided: boolean;
  onDecideApproval: (approvalId: string, approved: boolean) => void;
  /** Agent requesting the approval — the orchestrator instance driving the chat. */
  agentName?: string;
}

export function ApprovalCard({ approval, decided, onDecideApproval, agentName }: ApprovalCardProps): JSX.Element {
  return (
    <div className="border border-[#b45309]/60 bg-[#f1efe6] rounded-none shadow-[3px_3px_0_var(--paper-shadow)] overflow-hidden">
      <div className="flex items-center justify-between bg-[#f99c00]/15 border-b border-[#b45309]/40 px-3 py-1.5 min-h-[31px]">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#b45309]">approval.gate</span>
        <span className="bez-marks" aria-hidden="true"><i /><i /><i /></span>
      </div>
      <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono font-bold text-sm text-[#222320] flex items-center gap-2 min-w-0">
          <Tooltip content="Sacred Approval Gate — Zero Trust Security" side="bottom">
            <img
              src="/assets/mascot/pet-logo.png"
              alt="Shiba Guard"
              className="w-5 h-5 rounded-full bg-white object-contain border border-[#f99c00]/50 shrink-0 cursor-default"
            />
          </Tooltip>
          <span className="truncate">{approval.tool}</span>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-bold bg-[#b45309]/15 border border-[#b45309]/30 text-[#b45309] px-2 py-0.5 rounded-none shrink-0">
          Action Required
        </span>
      </div>

      {agentName !== undefined ? (
        <p className="text-[10px] font-mono text-[#6a6f63] truncate -mt-1">via {agentName}</p>
      ) : null}

      <pre className="whitespace-pre-wrap font-mono text-xs text-[#6a6f63] bg-[#fffef8] p-3 rounded-none border border-[#e0ded5] max-h-56 overflow-auto">
        {typeof approval.input === "string"
          ? approval.input
          : JSON.stringify(approval.input, null, 2)}
      </pre>

      <p className="text-xs text-[#6a6f63] leading-relaxed">
        Approving starts an isolated sandbox run. Rejecting stops the tool call.
      </p>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Tooltip content="Approve tool execution inside isolated container" side="top">
          <button
            type="button"
            className="bg-[#15803d] hover:bg-[#166534] text-[#fffef8] font-semibold py-2 px-5 touch:min-h-11 rounded-none transition-all disabled:opacity-50 text-sm shadow-[2px_2px_0_var(--paper-shadow)] flex items-center gap-1.5 active:scale-[0.98]"
            disabled={decided}
            onClick={() => onDecideApproval(approval.approvalId, true)}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
            <span>Approve</span>
          </button>
        </Tooltip>

        <Tooltip content="Reject tool execution and cancel operation" side="top">
          <button
            type="button"
            className="bg-transparent border border-[#fb2c36] text-[#fb2c36] hover:bg-[#fb2c36]/10 font-semibold py-2 px-5 touch:min-h-11 rounded-none transition-all disabled:opacity-50 text-sm flex items-center gap-1.5 active:scale-[0.98]"
            disabled={decided}
            onClick={() => onDecideApproval(approval.approvalId, false)}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span>Reject</span>
          </button>
        </Tooltip>
      </div>
      </div>
    </div>
  );
}

