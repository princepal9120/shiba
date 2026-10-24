/**
 * Stored-approval cards shared by the Approvals surface. The old right-hand
 * WorkspacePanel shell (Runs/VM/Diff tabs) was dead code — nothing mounted
 * it after the views became full pages — and is deleted.
 */
import { type JSX } from "react";
import { describeRoute } from "@shiba/shared";
import { formatTimeAgo, statusChipClass } from "../ui-helpers";
import type { StoredApproval } from "../types";

const ACCENT_BUTTON =
  "text-[11px] bg-[var(--primary-soft)] hover:bg-[var(--primary-soft)] border border-[var(--primary)]/15 text-[var(--primary)] font-medium py-1 px-2.5 touch:min-h-11 touch:px-3.5 rounded-[var(--radius-button)] transition-colors";
const DANGER_BUTTON =
  "text-[11px] bg-transparent hover:bg-[var(--destructive-soft)] border border-[var(--destructive)]/50 text-[var(--destructive)] font-medium py-1 px-2.5 touch:min-h-11 touch:px-3.5 rounded-[var(--radius-button)] transition-colors";

/** Kind-aware label for a stored approval pointer; unknown kinds render raw. */
export function storedApprovalKind(approval: StoredApproval): string {
  if (approval.kind === "email_send") return "Email send";
  if (approval.kind === "email_delete") return "Email delete";
  if (approval.kind === "pr_merge") return "Merge pull request";
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
  decision,
  onDecide,
}: {
  approval: StoredApproval;
  decided: boolean;
  /** Outcome when decided — mirrors the chat ApprovalCard. */
  decision?: boolean;
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
      ...(approval.reviewAfterPublish !== undefined
        ? { reviewAfterPublish: approval.reviewAfterPublish }
        : {}),
      ...(approval.runSetup !== undefined ? { runSetup: approval.runSetup } : {}),
      ...(approval.testCommand?.length ? { testCommand: approval.testCommand } : {}),
    } satisfies Record<string, unknown>);
  return (
    <div className="border border-[var(--border-1)] border-l-2 border-l-[var(--attention)] rounded-[var(--radius-button)] bg-[var(--bg)] p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--warning-fg)]">
          {storedApprovalKind(approval)}
        </span>
        <span className="text-[10px] text-[var(--muted-foreground-2)] font-mono">
          {formatTimeAgo(approval.createdAt)}
        </span>
      </div>
      <p className="text-[10px] font-mono text-[var(--muted-foreground-2)] truncate mb-1">
        via {storedApprovalAgent(approval)}
      </p>
      <p className="text-[11px] text-[var(--fg)] font-medium break-words mb-1">{approval.task}</p>
      {approval.reviewAfterPublish ? (
        <p className="text-[11px] text-[var(--fg)] break-words mb-1">
          After the PR opens, a read-only review will run and Shiba will post its findings as a PR review.
        </p>
      ) : null}
      {approval.route ? (
        <p className="text-[11px] font-mono text-[var(--muted-foreground-2)] break-words mb-1">
          <span className="font-semibold text-[var(--fg)]">Model:</span> {describeRoute(approval.route)}
        </p>
      ) : null}
      {approval.envNames?.length ? (
        <p className="text-[11px] font-mono text-[var(--muted-foreground-2)] break-words mb-1">
          <span className="font-semibold text-[var(--fg)]">Env:</span> {approval.envNames.join(", ")}
        </p>
      ) : null}
      {approval.runSetup ? (
        <p className="text-[11px] font-mono text-[var(--muted-foreground-2)] break-words mb-1">
          <span className="font-semibold text-[var(--fg)]">Setup:</span> runs .shiba/setup.json initialize
        </p>
      ) : null}
      {approval.testCommand?.length ? (
        <p className="text-[11px] font-mono text-[var(--muted-foreground-2)] break-words mb-1">
          <span className="font-semibold text-[var(--fg)]">Tests:</span> {approval.testCommand.join(" ")}
        </p>
      ) : null}
      <pre className="font-mono text-[10px] text-[var(--muted-foreground-2)] bg-[var(--card)] p-2 rounded-[var(--radius-button)] border border-[var(--border-1)] whitespace-pre-wrap break-words max-h-32 overflow-auto mb-2">
        {JSON.stringify(frozen, null, 2)}
      </pre>
      <p className="text-[11px] text-[var(--muted-foreground-2)] mb-2">
        Approve to start the run with the frozen payload above. Reject to discard it — nothing executes.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={ACCENT_BUTTON}
          disabled={decided}
          onClick={() => onDecide(approval, true)}
        >
          {decided && decision === true ? "Approved" : "Approve"}
        </button>
        <button
          type="button"
          className={DANGER_BUTTON}
          disabled={decided}
          onClick={() => onDecide(approval, false)}
        >
          {decided && decision === false ? "Rejected" : "Reject"}
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
    <div className="border border-[var(--border-1)] rounded-[var(--radius-button)] bg-[var(--bg)] p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted-foreground-2)]">
          {storedApprovalKind(approval)}
        </span>
        <span
          className={`text-[10px] font-bold uppercase tracking-wider border rounded-[var(--radius-button)] px-2 py-0.5 shrink-0 ${chip.cls}`}
        >
          {chip.label}
        </span>
      </div>
      <p className="text-[10px] font-mono text-[var(--muted-foreground-2)] truncate mb-1">
        via {storedApprovalAgent(approval)}
        {approval.decidedBy !== undefined ? ` · ${approval.decidedBy}` : ""}
      </p>
      <p className="text-[11px] text-[var(--fg)] font-medium break-words">{approval.task}</p>
      {approval.execution?.error !== undefined ? (
        <p className="text-[10px] text-[var(--destructive)] mt-1 break-words">{approval.execution.error}</p>
      ) : null}
      <p className="text-[10px] text-[var(--muted-foreground-2)] font-mono mt-1">
        {formatTimeAgo(approval.decidedAt ?? approval.createdAt)}
      </p>
    </div>
  );
}

