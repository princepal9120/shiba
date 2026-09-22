// Pure helpers shared by the dashboard. Keep deterministic: no fetch, no React.
import {
  getToolApproval,
  getToolCallId,
  getToolInput,
  getToolPartState,
} from "@cloudflare/ai-chat/react";
import { isToolUIPart, type UIMessage } from "ai";

export type ToolPart = UIMessage["parts"][number];

export interface PendingApproval {
  messageId: string;
  toolCallId: string;
  approvalId: string;
  tool: string;
  input: unknown;
}

// Mirrors app.tsx: only tool parts sitting in "waiting-approval" with an approval id.
export function extractPendingApprovals(messages: UIMessage[]): PendingApproval[] {
  const approvals: PendingApproval[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (getToolPartState(part) !== "waiting-approval") continue;
      const approval = getToolApproval(part);
      if (!approval) continue;
      approvals.push({
        messageId: message.id,
        toolCallId: getToolCallId(part),
        approvalId: approval.id,
        tool: toolDisplayName(part),
        input: getToolInput(part),
      });
    }
  }
  return approvals;
}

export function toolDisplayName(part: ToolPart): string {
  const raw = (part as { type?: unknown }).type;
  if (typeof raw === "string" && raw.startsWith("tool-")) {
    return raw.slice("tool-".length);
  }
  return typeof raw === "string" ? raw : "tool";
}

// Registry statuses: pending|running|completed|error|aborted|cancelled|unknown.
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  error: "Error",
  aborted: "Aborted",
  cancelled: "Cancelled",
  unknown: "Unknown",
  live: "Live",
  "waiting-approval": "Waiting",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * The error family for filters and counters: failures plus "unknown" — an
 * indeterminate outcome is grouped with failures for triage, not with success.
 */
export const ERROR_FAMILY_STATUSES: ReadonlySet<string> = new Set([
  "error",
  "aborted",
  "cancelled",
  "unknown",
]);

// Status chip classes — single source for app.tsx, WorkspacePanel, and any
// future pane that renders run/session status pills.
export const STATUS_CHIP_CLASSES: Record<string, string> = {
  completed: "text-[#15803d] border-[#15803d]/30 bg-[#15803d]/10",
  running: "text-[#0000a8] border-[#0000a8]/30 bg-[#0000a8]/10",
  pending: "text-[#b45309] border-[#f99c00]/40 bg-[#f99c00]/10",
  "waiting-approval": "text-[#b45309] border-[#f99c00]/40 bg-[#f99c00]/10",
  error: "text-[#fb2c36] border-[#fb2c36]/30 bg-[#fb2c36]/10",
  aborted: "text-[#fb2c36] border-[#fb2c36]/30 bg-[#fb2c36]/10",
  cancelled: "text-[#fb2c36] border-[#fb2c36]/30 bg-[#fb2c36]/10",
  // Amber, not error red: ambiguous outcome is not a known failure.
  unknown: "text-[#b45309] border-[#b45309]/30 bg-[#b45309]/10",
};

export function statusChipClass(status: string): string {
  return STATUS_CHIP_CLASSES[status] ?? "text-[#6a6f63] border-[#eae8e1] bg-[#fffef8]";
}

export function emptyDiffText(): string {
  return "No file changes produced";
}

// Diff output for completed live runs. The orchestrator surfaces the unified
// diff on the run record when present; anything else is not diff output.
export function extractCompletedDiff(run: unknown): string | null {
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

export function parseRepoName(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return url.pathname || repoUrl;
  } catch {
    return repoUrl || "unknown repository";
  }
}

export function formatTimeAgo(timestamp: number): string {
  if (!timestamp) return "unknown time";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
