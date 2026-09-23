/**
 * Slack slash-command route. Verifies the Slack HMAC signature, parses
 * `/shiba-ai-coworker <github-repo-url> <task>`, queues an orchestrator run, and
 * returns an ephemeral "Task queued" reply.
 *
 * Signature verification itself lives in src/slack.ts (Agent 7); this
 * module only wires the command to the orchestrator.
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { parseGitHubRepoUrl } from "./security.js";
import { buildApprovalBlocks } from "./slack-approval.js";
import { verifySlackRequest } from "./slack.js";

export const SLACK_COMMAND_PATH = "/api/slack/command";
export const SLASH_COMMAND = "/shiba-ai-coworker";

/** One shared orchestrator conversation; queue and approvals both resolve on it. */
export const ORCHESTRATOR_NAME = "default";

export interface OrchestratorStub {
  fetch: (request: Request) => Promise<Response>;
}

export interface SlackCommandDeps {
  orchestratorStub?: OrchestratorStub;
}

export interface ParsedSlackCommand {
  repoUrl: string;
  task: string;
}

/**
 * Extract the GitHub repository URL and task from slash-command text.
 * The first token that parses as a GitHub URL wins; everything else is
 * the task. Throws when either half is missing.
 */
export function parseSlackCommand(text: string): ParsedSlackCommand {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let repoUrl: string | null = null;
  const rest: string[] = [];
  for (const token of tokens) {
    if (repoUrl === null) {
      const candidate = token.replace(/[.,;:!?)]+$/, "");
      try {
        parseGitHubRepoUrl(candidate);
        repoUrl = candidate;
        continue;
      } catch {
        // Not a repository URL — it belongs to the task description.
      }
    }
    rest.push(token);
  }
  if (!repoUrl) {
    throw new Error("Usage: /shiba-ai-coworker <github-repo-url> <task>. Include a https://github.com/owner/repo URL.");
  }
  const task = rest.join(" ").trim();
  if (!task) {
    throw new Error("Usage: /shiba-ai-coworker <github-repo-url> <task>. Describe the task after the URL.");
  }
  return { repoUrl, task };
}

/**
 * Handle POST /api/slack/command. Returns null for any other path or
 * method so the Worker can fall through to the remaining routes.
 */
export async function handleSlackCommand(
  request: Request,
  env: Env & { SLACK_SIGNING_SECRET?: string },
  deps: SlackCommandDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SLACK_COMMAND_PATH || request.method !== "POST") {
    return null;
  }
  const secret = env.SLACK_SIGNING_SECRET ?? "";
  if (!secret) {
    return Response.json(
      { error: "Slack is not configured: set the SLACK_SIGNING_SECRET secret." },
      { status: 503 },
    );
  }
  // The raw body is the exact signed payload — parse the form after verifying.
  const rawBody = await request.text();
  if (!(await verifySlackRequest(rawBody, request.headers, secret))) {
    return Response.json({ error: "Invalid Slack signature." }, { status: 401 });
  }
  const params = new URLSearchParams(rawBody);
  if ((params.get("command") ?? "").trim() !== SLASH_COMMAND) {
    return Response.json({ error: "Unknown command." }, { status: 400 });
  }
  let parsed: ParsedSlackCommand;
  try {
    parsed = parseSlackCommand(params.get("text") ?? "");
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid command text." },
      { status: 400 },
    );
  }
  const stub: OrchestratorStub =
    deps.orchestratorStub ?? (await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME));
  let queued: Response;
  try {
    queued = await stub.fetch(
      new Request("https://internal/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: parsed.repoUrl,
          task: parsed.task,
          source: "slack",
          channel_id: params.get("channel_id"),
          user_id: params.get("user_id"),
        }),
      }),
    );
  } catch {
    return Response.json({ error: "Failed to queue orchestrator run." }, { status: 502 });
  }
  if (!queued.ok) {
    return Response.json({ error: "Failed to queue orchestrator run." }, { status: 502 });
  }
  const queuedBody = (await queued.json().catch(() => ({}))) as { approvalId?: string };
  if (!queuedBody.approvalId) {
    return Response.json({ error: "Orchestrator did not return an approval id." }, { status: 502 });
  }
  // The card rides in the command reply — no bot token needed to deliver it.
  return Response.json({
    response_type: "ephemeral",
    text: `Task queued for ${parsed.repoUrl}: ${parsed.task}`,
    blocks: buildApprovalBlocks({
      threadKey: ORCHESTRATOR_NAME,
      approvalId: queuedBody.approvalId,
      repoUrl: parsed.repoUrl,
      task: parsed.task,
    }),
  });
}
