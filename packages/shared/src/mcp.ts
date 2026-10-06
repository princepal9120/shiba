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
  // ACP lanes — every Agent Client Protocol agent the image ships.
  "claude-acp",
  "codex-acp",
  "gemini-acp",
  "opencode-acp",
  "devin-acp",
  // The generic registry lane: any ACP_REGISTRY_ALLOWLIST-ed agent,
  // `acp/<id>` as the model id.
  "acp",
] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const testCommandSchema = z.array(z.string().min(1)).max(8);

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
  codingModel: z
    .string()
    .optional()
    .describe("Coding model as provider/model, e.g. anthropic/claude-sonnet-4-6. Defaults to the deployment's per-harness model."),
  connectionId: z
    .string()
    .optional()
    .describe("Model connection id (conn_*) from the deployment's connection catalog. Defaults to the implicit gateway/secret route."),
  testCommand: testCommandSchema
    .optional()
    .describe("Project test command as an argv array, e.g. [\"pnpm\", \"test\"]."),
});

export type QueueRunInput = z.infer<typeof queueRunInputSchema>;

export const runStatusInputSchema = z.object({
  runId: z.string().min(1).describe("Run id, e.g. agent-tool:<approvalId>."),
});

const screenRunId = z.string().min(1).describe("Run id whose sandbox screen to drive — the run must be running.");

/** PLAN-V2-NEXT computer-use tools: one screen action per call, on a live run's sandbox. */
export const screenClickInputSchema = z.object({
  runId: screenRunId,
  x: z.number().int().min(0).describe("Horizontal pixel coordinate."),
  y: z.number().int().min(0).describe("Vertical pixel coordinate."),
  button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button. Defaults to left."),
});
export const screenTypeInputSchema = z.object({
  runId: screenRunId,
  text: z.string().min(1).max(4000).describe("Literal text to type — sent verbatim, never interpreted."),
});
export const screenScrollInputSchema = z.object({
  runId: screenRunId,
  dx: z.number().int().describe("Horizontal scroll pixels (negative = left)."),
  dy: z.number().int().describe("Vertical scroll pixels (negative = up)."),
});
export const screenKeyInputSchema = z.object({
  runId: screenRunId,
  keys: z.string().min(1).describe("xdotool key names, space-separated, e.g. \"ctrl+s\" or \"Return\"."),
});
export const screenShotInputSchema = z.object({
  runId: screenRunId,
});
export type ScreenClickInput = z.infer<typeof screenClickInputSchema>;
export type ScreenTypeInput = z.infer<typeof screenTypeInputSchema>;
export type ScreenScrollInput = z.infer<typeof screenScrollInputSchema>;
export type ScreenKeyInput = z.infer<typeof screenKeyInputSchema>;
export type ScreenShotInput = z.infer<typeof screenShotInputSchema>;

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
