/**
 * Authenticated trigger route. POST /api/trigger accepts a JSON task payload
 * from an external HTTP client (e.g. an iPhone Apple Shortcut) and queues it
 * as a pending orchestrator approval.
 *
 * Auth is a shared bearer token (`TRIGGER_TOKEN`) compared in constant time;
 * queued runs land on the shared "default" orchestrator so the approval card
 * resolves on the dashboard's /api/approvals surface like any Slack-queued
 * run.
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { parseGitHubRepoUrl } from "./security.js";
import { timingSafeEqual } from "./slack.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";

export const TRIGGER_PATH = "/api/trigger";

export interface TriggerDeps {
  orchestratorStub?: { fetch: (r: Request) => Promise<Response> };
}

interface TriggerBody {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
}

/**
 * Parse and validate the JSON trigger body. Throws with a client-safe
 * message on any shape violation.
 */
function parseTriggerBody(body: unknown): TriggerBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const repoUrl = typeof input.repoUrl === "string" ? input.repoUrl.trim() : "";
  if (!repoUrl) {
    throw new Error("repoUrl is required.");
  }
  parseGitHubRepoUrl(repoUrl);
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!task) {
    throw new Error("task is required.");
  }
  const baseBranch =
    typeof input.baseBranch === "string" && input.baseBranch.trim() ? input.baseBranch.trim() : "main";
  const publishPullRequest = input.publishPullRequest === true;
  return { repoUrl, task, baseBranch, publishPullRequest };
}

/**
 * Handle POST /api/trigger. Returns null for any other path or method so
 * the Worker can fall through to the remaining routes.
 */
export async function handleTrigger(
  request: Request,
  env: Env,
  deps: TriggerDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TRIGGER_PATH || request.method !== "POST") {
    return null;
  }
  const token = env.TRIGGER_TOKEN?.trim() ?? "";
  // A short token is brute-forceable over the wire; fail closed rather than
  // silently accept a weak deployment. openssl rand -hex 32 satisfies this.
  if (token.length < 32) {
    return Response.json(
      { error: "Trigger endpoint is not configured: set the TRIGGER_TOKEN secret (min 32 chars)." },
      { status: 503 },
    );
  }
  const authorization = request.headers.get("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!presented || !timingSafeEqual(presented, token)) {
    return Response.json({ error: "Invalid trigger token." }, { status: 401 });
  }
  let parsed: TriggerBody;
  try {
    parsed = parseTriggerBody(await request.json());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid JSON body." },
      { status: 400 },
    );
  }
  const stub = deps.orchestratorStub ?? (await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME));
  let queued: Response;
  try {
    queued = await stub.fetch(
      new Request("https://internal/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: parsed.repoUrl,
          task: parsed.task,
          baseBranch: parsed.baseBranch,
          publishPullRequest: parsed.publishPullRequest,
          source: "trigger",
        }),
      }),
    );
  } catch {
    return Response.json({ error: "Failed to queue orchestrator run." }, { status: 502 });
  }
  if (!queued.ok) {
    const detail = await queued.text().catch(() => "");
    return Response.json(
      { error: `Failed to queue orchestrator run.${detail ? ` ${detail}` : ""}` },
      { status: 502 },
    );
  }
  const queuedBody = (await queued.json().catch(() => ({}))) as { approvalId?: string };
  if (!queuedBody.approvalId) {
    return Response.json({ error: "Orchestrator did not return an approval id." }, { status: 502 });
  }
  return Response.json({
    status: "pending_approval",
    approvalId: queuedBody.approvalId,
    approveUrl: `${url.origin}/app/`,
    message: "queued — approve it on the dashboard",
  });
}
