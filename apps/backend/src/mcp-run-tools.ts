// Run tools for external agents: queue runs for human approval and read run state via the
// same orchestrator routes /api/runs and /api/approvals use. Deliberately no approve tool.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getAgentByName } from "agents/routing";
import { z } from "zod";
import type { Env } from "./env.js";
import type { ToolRegistry } from "./mcp-gateway.js";

const ORCHESTRATOR_NAME = "default";
const DEFAULT_LIST_LIMIT = 20;

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

async function orchestratorJson(env: Env, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const stub = await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME);
  const res = await stub.fetch(new Request(`https://internal${path}`, init));
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `orchestrator returned ${res.status}`);
  }
  return body;
}

export function registerRunTools(registry: ToolRegistry, env: Env): void {
  registry.registerTool(
    "queue_run",
    "sandbox:exec",
    async (args) => {
      const body = await orchestratorJson(env, "/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Fields are picked, never spread: a caller-supplied `kind` would
        // let a sandbox:exec token mint an email approval.
        body: JSON.stringify({
          kind: "run",
          threadKey: ORCHESTRATOR_NAME,
          repoUrl: args.repoUrl,
          task: args.task,
          baseBranch: args.baseBranch,
          publishPullRequest: args.publishPullRequest,
        }),
      });
      const approvalId = String(body.approvalId);
      return jsonResult({
        status: "pending_approval",
        approvalId,
        // resolveApproval mints the run as `agent-tool:<approvalId>`.
        runId: `agent-tool:${approvalId}`,
        note: "Nothing runs until a human approves this in the dashboard or Slack. After approval, poll run_status with runId.",
      });
    },
    {
      description:
        "Queue a coding task on a GitHub repo as a pending approval. Never starts a run: a human " +
        "approves it in the dashboard or Slack, then it runs with the deployment's default harness and model.",
      inputSchema: {
        repoUrl: z.string().describe("HTTPS GitHub repository URL, e.g. https://github.com/owner/repo."),
        task: z.string().describe("The coding task to perform in the repository."),
        baseBranch: z.string().optional().describe("Base branch to clone. Defaults to main."),
        publishPullRequest: z
          .boolean()
          .optional()
          .describe("Open a pull request with the result. Requires GITHUB_TOKEN on the deployment."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );

  registry.registerTool(
    "run_status",
    "sandbox:exec",
    async (args) =>
      jsonResult(await orchestratorJson(env, `/api/runs/${encodeURIComponent(String(args.runId))}`)),
    {
      description: "Fetch one run record (status, result, pull request) by runId.",
      inputSchema: { runId: z.string().min(1).describe("Run id, e.g. agent-tool:<approvalId>.") },
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "list_runs",
    "sandbox:exec",
    async (args) => {
      const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : DEFAULT_LIST_LIMIT;
      const { runs } = await orchestratorJson(env, "/api/runs");
      // The DO stores runs oldest first; callers want the newest.
      return jsonResult({ runs: (Array.isArray(runs) ? runs : []).slice(-limit).reverse() });
    },
    {
      description: `List run records, newest first (default ${DEFAULT_LIST_LIMIT}).`,
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "list_approvals",
    "sandbox:exec",
    async () => {
      const { approvals, decided } = await orchestratorJson(env, "/api/approvals");
      // Email approvals freeze message bodies — those stay behind email scopes.
      const runsOnly = (list: unknown) =>
        (Array.isArray(list) ? (list as Array<{ kind?: string }>) : []).filter((a) => (a.kind ?? "run") === "run");
      return jsonResult({ approvals: runsOnly(approvals), decided: runsOnly(decided) });
    },
    {
      description: "List pending run approvals plus recently decided ones. Approving is a human act — there is no approve tool.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
  );
}
