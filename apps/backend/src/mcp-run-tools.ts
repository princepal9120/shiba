// Run tools for external agents: queue runs for human approval and read run state via the
// same orchestrator routes /api/runs and /api/approvals use. Deliberately no approve tool.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getAgentByName } from "agents/routing";
import { z } from "zod";
import type { Env } from "./env.js";
import type { ToolRegistry } from "./mcp-gateway.js";
import { AGENT_PRINCIPAL_HEADER } from "./runs.js";

const ORCHESTRATOR_NAME = "default";
const DEFAULT_LIST_LIMIT = 20;

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

async function orchestratorJson(env: Env, path: string, init?: RequestInit, principal?: string): Promise<Record<string, unknown>> {
  const stub = await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME);
  const request = new Request(`https://internal${path}`, init);
  // Vouched principal: the DO scopes run/approval reads and stamps
  // queuedBy on intakes, so one agent token can never see or cancel
  // another agent's runs.
  if (principal) request.headers.set(AGENT_PRINCIPAL_HEADER, principal);
  const res = await stub.fetch(request);
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
    async (args, ctx) => {
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
          harness: args.harness,
        }),
      }, ctx.principal.principal);
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
        "approves it in the dashboard or Slack, then it runs with the requested or default harness and model.",
      inputSchema: {
        repoUrl: z.string().describe("HTTPS GitHub repository URL, e.g. https://github.com/owner/repo."),
        task: z.string().describe("The coding task to perform in the repository."),
        baseBranch: z.string().optional().describe("Base branch to clone. Defaults to main."),
        publishPullRequest: z
          .boolean()
          .optional()
          .describe("Open a pull request with the result. Requires GITHUB_TOKEN on the deployment."),
        harness: z
          .enum(["opencode", "claude-code", "codex", "devin"])
          .optional()
          .describe("Coding agent harness. Defaults to the deployment's AGENT_HARNESS."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  );

  registry.registerTool(
    "run_status",
    "runs:read",
    async (args, ctx) =>
      jsonResult(await orchestratorJson(env, `/api/runs/${encodeURIComponent(String(args.runId))}`, undefined, ctx.principal.principal)),
    {
      description: "Fetch one run record (status, result, pull request) by runId.",
      inputSchema: { runId: z.string().min(1).describe("Run id, e.g. agent-tool:<approvalId>.") },
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "list_runs",
    "runs:read",
    async (args, ctx) => {
      const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : DEFAULT_LIST_LIMIT;
      // The DO slices newest-first itself — no full-registry fetch.
      const { runs } = await orchestratorJson(env, `/api/runs?limit=${limit}`, undefined, ctx.principal.principal);
      return jsonResult({ runs: Array.isArray(runs) ? runs : [] });
    },
    {
      description: `List run records, newest first (default ${DEFAULT_LIST_LIMIT}).`,
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
  );

  registry.registerTool(
    "list_approvals",
    "runs:read",
    async (_args, ctx) => {
      const { approvals, decided } = await orchestratorJson(env, "/api/approvals", undefined, ctx.principal.principal);
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
