/**
 * Stored-approval cards shared by the Approvals surface. The old right-hand
 * WorkspacePanel shell (Runs/VM/Diff tabs) was dead code — nothing mounted
 * it after the views became full pages — and is deleted.
 */
import { type JSX } from "react";
import { formatTimeAgo, statusChipClass } from "../ui-helpers";
import type { StoredApproval } from "../types";

const ACCENT_BUTTON =
  "text-[11px] bg-[#0000a8]/10 hover:bg-[#0000a8]/15 border border-[#0000a8]/15 text-[#1c1cc8] font-medium py-1 px-2.5 touch:min-h-11 touch:px-3.5 rounded-none transition-colors";
const DANGER_BUTTON =
  "text-[11px] bg-transparent hover:bg-[#fb2c36]/10 border border-[#fb2c36]/50 text-[#fb2c36] font-medium py-1 px-2.5 touch:min-h-11 touch:px-3.5 rounded-none transition-colors";

/** Kind-aware label for a stored approval pointer; unknown kinds render raw. */
export function storedApprovalKind(approval: StoredApproval): string {
  if (approval.kind === "email_send") return "Email send";
  if (approval.kind === "email_delete") return "Email delete";
  if (approval.kind === undefined || approval.kind === "run") return "Run task";
  return approval.kind;
}

/**
 * Which agent holds this approval. Email kinds ride the mailbox (payload
 * mailbox, falling back to the repoUrl slot where the bridge parks the
 * mailbox address); run kinds name the queueing thread (user identity,
 * slack:… channel, or the shared orchestrator default).
 */
export function storedApprovalAgent(approval: StoredApproval): string {
  const payload = approval.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const mailbox = (payload as Record<string, unknown>).mailbox;
    if (typeof mailbox === "string" && mailbox.trim() !== "") return mailbox;
  }
  if (approval.kind === "email_send" || approval.kind === "email_delete") {
    return approval.repoUrl;
  }
  return approval.threadKey === "" ? "orchestrator" : approval.threadKey;
}

/**
 * Card for an orchestrator-DO approval pointer: the frozen payload is
 * what executes on approve — shown verbatim, same discipline as the
 * chat-part ApprovalCard. Rejecting an email_send releases its queued
 * draft back to editing.
 */
export function StoredApprovalCard({
  approval,
  decided,
  onDecide,
}: {
  approval: StoredApproval;
  decided: boolean;
  onDecide: (approval: StoredApproval, ok: boolean) => void;
}): JSX.Element {
  const frozen =
    approval.payload ??
    ({
      repoUrl: approval.repoUrl,
      task: approval.task,
      ...(approval.baseBranch !== undefined ? { baseBranch: approval.baseBranch } : {}),
      ...(approval.publishPullRequest !== undefined
        ? { publishPullRequest: approval.publishPullRequest }
        : {}),
      ...(approval.testCommand?.length ? { testCommand: approval.testCommand } : {}),
    } satisfies Record<string, unknown>);
  return (
    <div className="border border-[#e0ded5] border-l-2 border-l-[#b45309] rounded-none bg-[#f6f4ed] p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#b45309]">
          {storedApprovalKind(approval)}
        </span>
        <span className="text-[10px] text-[#6a6f63] font-mono">
          {formatTimeAgo(approval.createdAt)}
        </span>
      </div>
      <p className="text-[10px] font-mono text-[#6a6f63] truncate mb-1">
        via {storedApprovalAgent(approval)}
      </p>
      <p className="text-[11px] text-[#222320] font-medium break-words mb-1">{approval.task}</p>
      {approval.testCommand?.length ? (
        <p className="text-[11px] font-mono text-[#6a6f63] break-words mb-1">
          <span className="font-semibold text-[#222320]">Tests:</span> {approval.testCommand.join(" ")}
        </p>
      ) : null}
      <pre className="font-mono text-[10px] text-[#6a6f63] bg-[#fffef8] p-2 rounded-none border border-[#e0ded5] whitespace-pre-wrap break-words max-h-32 overflow-auto mb-2">
        {JSON.stringify(frozen, null, 2)}
      </pre>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={ACCENT_BUTTON}
          disabled={decided}
          onClick={() => onDecide(approval, true)}
        >
          {decided ? "Decided" : "Approve"}
        </button>
        <button
          type="button"
          className={DANGER_BUTTON}
          disabled={decided}
          onClick={() => onDecide(approval, false)}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/**
 * Read-only row for a decided DO approval — the audit surface for what
 * the pending list drops once a pointer resolves. An approved email
 * approval's execution stamp lands here, so a failed send shows its
 * error instead of vanishing.
 */
export function DecidedApprovalRow({ approval }: { approval: StoredApproval }): JSX.Element {
  const chip =
    approval.status === "rejected"
      ? { label: "Rejected", cls: statusChipClass("rejected") }
      : approval.execution?.status === "failed"
        ? { label: "Failed", cls: statusChipClass("error") }
        : approval.execution?.status === "executed"
          ? { label: "Executed", cls: statusChipClass("completed") }
          : { label: "Approved", cls: statusChipClass("running") };
  return (
    <div className="border border-[#e0ded5] rounded-none bg-[#f6f4ed] p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6f63]">
          {storedApprovalKind(approval)}
        </span>
        <span
          className={`text-[10px] font-bold uppercase tracking-wider border rounded-none px-2 py-0.5 shrink-0 ${chip.cls}`}
        >
          {chip.label}
        </span>
      </div>
      <p className="text-[10px] font-mono text-[#6a6f63] truncate mb-1">
        via {storedApprovalAgent(approval)}
        {approval.decidedBy !== undefined ? ` · ${approval.decidedBy}` : ""}
      </p>
      <p className="text-[11px] text-[#222320] font-medium break-words">{approval.task}</p>
      {approval.execution?.error !== undefined ? (
        <p className="text-[10px] text-[#fb2c36] mt-1 break-words">{approval.execution.error}</p>
      ) : null}
      <p className="text-[10px] text-[#6a6f63] font-mono mt-1">
        {formatTimeAgo(approval.decidedAt ?? approval.createdAt)}
      </p>
    </div>
  );
}

