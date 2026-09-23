/**
 * Pure transcript helpers for the coding sub-agent. Kept dependency-free
 * so unit tests can import them without Cloudflare runtime modules.
 */
import type { CodingTaskInput, CodingTaskResult } from "./opencode-input.js";
import type { ProgressEvent } from "./runtime.js";
import { boundTail, redactSecrets } from "./security.js";

/** Join the text parts of a UI message. Non-text parts are ignored. */
export function messageText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const parts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    }
  }
  return chunks.join("\n");
}

/**
 * Build the assistant text for one run: task header, progress lines,
 * changed files, bounded diff, optional pull request URL, or the honest
 * failure summary with stderr tail.
 */
export function renderRunTranscript(args: {
  input: CodingTaskInput;
  progress: ProgressEvent[];
  result: CodingTaskResult;
  pullUrl?: string;
}): string[] {
  const lines = [
    `Task: ${args.input.task}`,
    `Repository: ${args.input.repoUrl} (${args.input.baseBranch})`,
    `Sandbox: ${args.input.sandboxId}`,
  ];
  for (const event of args.progress) {
    lines.push(`[${event.phase}] ${event.message}`);
  }
  if (args.result.status === "completed") {
    lines.push(
      args.result.changedFiles.length > 0
        ? `Changed files: ${args.result.changedFiles.join(", ")}`
        : "No file changes detected.",
    );
    if (args.result.diff) {
      lines.push("Diff:");
      lines.push(boundTail(redactSecrets(args.result.diff), 20_000));
    }
    if (args.pullUrl) {
      lines.push(`Pull request: ${args.pullUrl}`);
    }
  } else {
    lines.push(`Failed: ${args.result.summary}`);
    if (args.result.stderrTail) {
      lines.push(`stderr tail:\n${args.result.stderrTail}`);
    }
  }
  return lines.map(redactSecrets);
}
