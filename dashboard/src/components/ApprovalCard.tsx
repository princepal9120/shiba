// ApprovalCard — the sacred approval gate UI. waiting-approval tool calls
// surface this card with Approve/Reject wired to chat.addToolApprovalResponse
// via the parent's onDecideApproval. Never auto-approve; never hide.
import type { JSX } from "react";
import type { PendingApproval } from "../ui-helpers";

export interface ApprovalCardProps {
  approval: PendingApproval;
  decided: boolean;
  onDecideApproval: (approvalId: string, approved: boolean) => void;
}

export function ApprovalCard({ approval, decided, onDecideApproval }: ApprovalCardProps): JSX.Element {
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
        {typeof approval.input === "string"
          ? approval.input
          : JSON.stringify(approval.input, null, 2)}
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
