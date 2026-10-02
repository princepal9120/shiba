/**
 * MCP tool argument shapes — the zod schemas external agents validate
 * against at the `/mcp` gateway. Descriptions are the tool docs; keep
 * them in sync with the registry registrations in the backend.
 */
import { z } from "zod";

/**
 * Names an external caller may request. Subscription harnesses are included
 * even though each is flag-gated — resolution stays deny-by-default, so an
 * unknown or disabled name fails at resolveHarness, not silently in-container.
 * Bare cursor/antigravity stay excluded: they declare no runtimes.
 */
export const HARNESS_IDS = [
  "opencode",
  "claude-code",
  "claude-subscription",
  "codex",
  "codex-subscription",
  "devin",
  "devin-subscription",
  "grok",
  "antigravity-subscription",
  "cursor-subscription",
] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const queueRunInputSchema = z.object({
  repoUrl: z.string().describe("HTTPS GitHub repository URL, e.g. https://github.com/owner/repo."),
  task: z.string().describe("The coding task to perform in the repository."),
  baseBranch: z.string().optional().describe("Base branch to clone. Defaults to main."),
  publishPullRequest: z
    .boolean()
    .optional()
    .describe("Open a pull request with the result. Requires GITHUB_TOKEN on the deployment."),
  harness: z
    .enum(HARNESS_IDS)
    .optional()
    .describe("Coding agent harness. Defaults to the deployment's AGENT_HARNESS."),
});

export type QueueRunInput = z.infer<typeof queueRunInputSchema>;

export const runStatusInputSchema = z.object({
  runId: z.string().min(1).describe("Run id, e.g. agent-tool:<approvalId>."),
});

export type RunStatusInput = z.infer<typeof runStatusInputSchema>;

export const listRunsInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

export type ListRunsInput = z.infer<typeof listRunsInputSchema>;

/** queue_run returns an approval pointer, never a started run. */
export interface QueueRunResult {
  status: "pending_approval";
  approvalId: string;
  /** The run is minted as `agent-tool:<approvalId>` on approval. */
  runId: string;
  note: string;
}
