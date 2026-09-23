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
import { parseGitHubRepoUrl, redactSecrets } from "./security.js";
import { buildApprovalBlocks, type ExecutionContextLike } from "./slack-approval.js";
import { buildSlackRunPayload } from "./slack-thread.js";
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
  /** Deliver the queued card/error to the command's response_url. */
  respond?: (responseUrl: string, body: Record<string, unknown>) => Promise<void>;
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
 * Slash-command response_urls live under hooks.slack.com/commands/ — the
 * /actions/ check in slack-approval.ts covers interactivity URLs only.
 */
export function isSlackCommandResponseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) &&
      url.username === "" && url.password === "" && url.port === "" &&
      url.pathname.startsWith("/commands/");
  } catch {
    return false;
  }
}

async function respondToCommand(
  responseUrl: string,
  body: Record<string, unknown>,
  respond?: SlackCommandDeps["respond"],
): Promise<void> {
  if (respond) {
    await respond(responseUrl, body);
    return;
  }
  const response = await fetch(responseUrl, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Slack response_url POST failed (${response.status}).`);
  }
}

/**
 * Queue the run on the shared orchestrator and shape the reply Slack shows:
 * the approval card on success, an ephemeral error otherwise. Never throws.
 */
async function queueSlackRun(
  env: Env,
  deps: SlackCommandDeps,
  parsed: ParsedSlackCommand,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  let queued: Response;
  try {
    const stub: OrchestratorStub =
      deps.orchestratorStub ?? (await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME));
    queued = await stub.fetch(
      new Request("https://internal/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same payload as the mention lane: publishPullRequest on, channel/user carried.
        body: JSON.stringify(buildSlackRunPayload({
          repoUrl: parsed.repoUrl,
          task: parsed.task,
          channelId: params.get("channel_id") ?? undefined,
          userId: params.get("user_id") ?? undefined,
        })),
      }),
    );
  } catch {
    return { response_type: "ephemeral", text: "Failed to queue the task — the orchestrator is unreachable." };
  }
  const queuedBody = (await queued.json().catch(() => ({}))) as { approvalId?: string; error?: unknown };
  if (!queued.ok || !queuedBody.approvalId) {
    // Surface the orchestrator's reason: a config error (e.g. no GITHUB_TOKEN) won't clear on retry.
    const reason = typeof queuedBody.error === "string" ? queuedBody.error : "Try again in a moment.";
    return { response_type: "ephemeral", text: `Failed to queue the task. ${reason}` };
  }
  return {
    response_type: "ephemeral",
    text: `Task queued for ${parsed.repoUrl}: ${parsed.task}`,
    blocks: buildApprovalBlocks({
      threadKey: ORCHESTRATOR_NAME,
      approvalId: queuedBody.approvalId,
      repoUrl: parsed.repoUrl,
      task: parsed.task,
    }),
  };
}

/**
 * Handle POST /api/slack/command. Returns null for any other path or
 * method so the Worker can fall through to the remaining routes.
 *
 * With a ctx and a response_url it acks at once (Slack's 3s window) and
 * posts the card or failure to the response_url under `ctx.waitUntil`;
 * otherwise it awaits the queue and returns the card inline.
 */
export async function handleSlackCommand(
  request: Request,
  env: Env & { SLACK_SIGNING_SECRET?: string },
  deps: SlackCommandDeps = {},
  ctx?: ExecutionContextLike,
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
    // A 4xx renders as Slack's generic "failed" — a 200 ephemeral carries
    // the usage hint back to the user instead.
    return Response.json({
      response_type: "ephemeral",
      text: error instanceof Error ? error.message : "Invalid command text.",
    });
  }
  const responseUrl = params.get("response_url") ?? "";
  if (ctx && isSlackCommandResponseUrl(responseUrl)) {
    ctx.waitUntil(
      queueSlackRun(env, deps, parsed, params)
        .then((body) => respondToCommand(responseUrl, body, deps.respond))
        .catch((error: unknown) => {
          console.error("Slack command reply failed", redactSecrets(String(error)));
        }),
    );
    return Response.json({ response_type: "ephemeral", text: "Queueing your task…" });
  }
  return Response.json(await queueSlackRun(env, deps, parsed, params));
}
