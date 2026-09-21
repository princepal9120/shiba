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
    <div className="border border-white/[0.07] bg-[#101013] rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono font-medium text-sm text-zinc-200 flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#d9a13b] shrink-0" aria-hidden="true" />
          <span className="truncate">{approval.tool}</span>
        </div>
        <span className="text-[10px] uppercase tracking-wide font-medium bg-[#d9a13b]/10 border border-[#d9a13b]/30 text-[#d9a13b] px-2 py-0.5 rounded-md shrink-0">
          Action Required
        </span>
      </div>

      <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-500 bg-[#0a0a0b] p-3 rounded-md border border-white/[0.07] max-h-56 overflow-auto">
        {typeof approval.input === "string"
          ? approval.input
          : JSON.stringify(approval.input, null, 2)}
      </pre>

      <p className="text-xs text-zinc-500 leading-relaxed">
        Approving starts an isolated sandbox run. Rejecting stops the tool call.
      </p>

      <div className="flex items-center gap-3 pt-1">
        <button
            type="button"
            className="bg-zinc-100 hover:bg-white text-zinc-900 font-medium py-2 px-5 rounded-md transition-colors disabled:opacity-50 text-sm flex items-center gap-1.5 active:scale-[0.98]"
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
            className="bg-transparent border border-white/10 text-zinc-300 hover:bg-white/5 font-medium py-2 px-5 rounded-md transition-colors disabled:opacity-50 text-sm flex items-center gap-1.5 active:scale-[0.98]"
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

