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

/**
 * /api/runs list URL. Ordinary views consume the lean `view=summary`
 * projection (leader-owned backend contract: required run fields plus
 * `hasDiff`, without diff/receipts/signals/steering); the diff inspector
 * asks for the full payload. No `limit` — retained history stays whole.
 */
export function runsListUrl(
  sessionId: string,
  sessionApiAvailable: boolean,
  fullDetail: boolean,
): string {
  const params = new URLSearchParams();
  if (sessionApiAvailable) params.set("session", sessionId);
  if (!fullDetail) params.set("view", "summary");
  const query = params.toString();
  return query === "" ? "/api/runs" : `/api/runs?${query}`;
}

// Object-valued tool outputs serialize identically for identical objects;
// cache by output identity so re-rendered history doesn't re-stringify.
const toolOutputCache = new WeakMap<object, string>();

/**
 * Default tool-output renderer for the step timeline. Identical to the old
 * inline formatter, plus a WeakMap memo keyed on the output object — React
 * element identity can't stop a re-render, but this stops the re-serialize.
 */
export function formatToolOutput(part: ToolPart): string | null {
  if (typeof part !== "object" || part === null) return null;
  const typed = part as Record<string, unknown>;
  const output = typed.output ?? typed.result;
  if (output === undefined || output === null) return null;
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const cached = toolOutputCache.get(output);
    if (cached !== undefined) return cached;
    const serialized = JSON.stringify(output, null, 2);
    toolOutputCache.set(output, serialized);
    return serialized;
  }
  return JSON.stringify(output, null, 2);
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
  ready: "Ready",
  "needs-provider": "Needs a provider",
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
  completed: "text-[var(--success)] border-[color-mix(in_oklch,var(--success)_30%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)]",
  ready: "text-[var(--muted-foreground-2)] border-[var(--border-1)] bg-[var(--card)]",
  running: "text-[var(--primary)] border-[var(--primary)]/30 bg-[var(--primary-soft)]",
  pending: "text-[var(--warning-fg)] border-[color-mix(in_oklch,var(--warning)_40%,transparent)] bg-[var(--warning-subtle)]",
  "waiting-approval": "text-[var(--warning-fg)] border-[color-mix(in_oklch,var(--warning)_40%,transparent)] bg-[var(--warning-subtle)]",
  error: "text-[var(--destructive)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)]",
  aborted: "text-[var(--destructive)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)]",
  cancelled: "text-[var(--destructive)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[var(--destructive-soft)]",
  // Amber, not error red: ambiguous outcome is not a known failure.
  unknown: "text-[var(--warning-fg)] border-[color-mix(in_oklch,var(--warning-fg)_30%,transparent)] bg-[color-mix(in_oklch,var(--warning-fg)_10%,transparent)]",
};

export function statusChipClass(status: string): string {
  return STATUS_CHIP_CLASSES[status] ?? "text-[var(--muted-foreground-2)] border-[var(--border-1)] bg-[var(--card)]";
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

/**
 * Reads and removes the ?prompt= parameter from location.search for composer prefill.
 * Blank or whitespace-only values return null. Length is capped at 4000 characters.
 */
export function readPromptParam(search: string): { prompt: string | null; nextSearch: string } {
  const params = new URLSearchParams(search);
  const raw = params.get("prompt");
  if (raw === null || raw.trim() === "") {
    return { prompt: null, nextSearch: params.toString() ? `?${params.toString()}` : "" };
  }
  params.delete("prompt");
  const nextSearch = params.toString() ? `?${params.toString()}` : "";
  const prompt = raw.slice(0, 4000);
  return { prompt, nextSearch };
}
