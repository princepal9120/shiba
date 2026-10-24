import { getAgentByName } from "agents/routing";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_DASHBOARD, LOCAL_INTAKE_HEADER, laneForRun, type DelegatedRun } from "@shiba/shared";
import { signInternalRequest } from "./edge-identity.js";
import type { Env } from "./env.js";
import { resolveRunStoreTarget } from "./runs-routes.js";
import {
  authorizeV1Request,
  requireV1Read,
  requireV1Write,
  v1Forbidden,
  v1Unauthorized,
  type V1Principal,
} from "./v1-auth.js";
import {
  readThreadCreateReceipt,
  threadCreateCommandId,
  writeThreadCreateReceipt,
} from "./v1-idempotency.js";
import type { V1Context } from "./v1/context.js";
import { handleOpenApi } from "./v1/openapi.js";
import { handleQueuedMessagesList, handleSendMessage } from "./v1/send-message.js";
import { handleSubagents } from "./v1/subagents.js";
import { handleThreadStream } from "./v1/stream.js";
import { handleAutomations } from "./v1/automations.js";
import { handleBilling } from "./v1/billing.js";
import { handleMcp } from "./v1/mcp.js";
import { handleRepositories } from "./v1/repositories.js";
import { handleDiffs } from "./v1/diffs.js";
import { handleEvents } from "./v1/events.js";
import { handleMessages } from "./v1/messages.js";
import { handlePreviews } from "./v1/previews.js";
import { handlePulls } from "./v1/pulls.js";
import { handleRuns } from "./v1/runs.js";
import { handleSystem } from "./v1/system.js";
import { handleOrgAgents } from "./v1/org-agents.js";
import { handleThreads } from "./v1/threads.js";
import { publicRunMessage, runTimedOut } from "./public-error.js";
import { reviewerTask } from "./review/prompt.js";
import { v1RunQueueBody } from "./v1/run-intake.js";

export interface V1RouteDeps {
  authorize?: (request: Request, env: Env) => Promise<V1Principal | null>;
  /** @deprecated use `authorize` */
  isAuthorized?: (request: Request, env: Env) => Promise<boolean>;
  resolveTarget?: typeof resolveRunStoreTarget;
  getStub?: (env: Env, agentName: string) => Promise<{ fetch(request: Request): Promise<Response> }>;
}

export function v1Thread(run: DelegatedRun) {
  return {
    threadId: run.runId, repoUrl: run.repoUrl,
    title: run.task.split("\n")[0]?.trim().slice(0, 80) || "Untitled thread",
    status: run.status, lane: laneForRun(run), archived: run.archivedAt !== undefined,
    costUsd: run.usage?.costUsd ?? null, createdAt: run.createdAt, updatedAt: run.updatedAt,
    pullUrl: run.pullUrl ?? null, summary: run.summary ?? null,
    error: publicRunMessage(run), errorCode: run.errorCode ?? null, timedOut: runTimedOut(run),
    usage: run.usage ?? null,
  };
}

export function v1Tasks(run: DelegatedRun) {
  return [{ name: "run", at: run.createdAt }, ...(run.signals ?? []).map((signal) => ({
    name: signal.kind, at: signal.at, ok: true,
  }))];
}

export async function handleV1(request: Request, env: Env, deps: V1RouteDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/v1/")) return null;
  if (url.pathname === "/api/v1/openapi.json" && request.method === "GET") {
    return Response.json(
      (await import("./v1/openapi.json", { with: { type: "json" } })).default,
      { headers: { "cache-control": "no-store" } },
    );
  }
  const dashboardScopes = ["api:read", "api:write", "api:keys:admin"] as V1Principal["scopes"];
  const principal = deps.authorize
    ? await deps.authorize(request, env)
    : deps.isAuthorized && (await deps.isAuthorized(request, env))
      ? { principal: "test", orgId: "self-hosted", scopes: dashboardScopes }
      : await authorizeV1Request(request, env);
  if (!principal) {
    return v1Unauthorized();
  }
  // Hoplite-shape groups first; each returns null when the path is not theirs.
  if (request.method === "POST") url.pathname = url.pathname.replace(/^(\/api\/v1\/threads\/[^/]+)\/messages$/, "$1/message");
  const ctx: V1Context = { request, env, url, principal, forward: async (method, path, input) => {
    const resolved = await (deps.resolveTarget ?? resolveRunStoreTarget)(request, env, url);
    if ("error" in resolved) return resolved.error;
    const stub = await (deps.getStub ?? (async (bindings, name) => getAgentByName(bindings.CodingOrchestrator, name)))(env, resolved.agentName);
    const headers = new Headers(request.headers);
    headers.set(LOCAL_INTAKE_HEADER, LOCAL_INTAKE_DASHBOARD);
    headers.delete(AGENT_PRINCIPAL_HEADER);
    headers.delete("content-length");
    if (input) headers.set("content-type", "application/json");
    const internal = new Request(new URL(path, request.url), { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
    await signInternalRequest(internal, env);
    return stub.fetch(internal);
  } };
  for (const group of [
    handleOpenApi,
    handleSendMessage,
    handleQueuedMessagesList,
    handleSubagents,
    handleThreadStream,
    handleSystem,
    handleThreads,
    handleMessages,
    handleRuns,
    handleDiffs,
    handlePulls,
    handlePreviews,
    handleBilling,
    handleEvents,
    handleRepositories,
    handleMcp,
    handleAutomations,
    handleOrgAgents,
  ]) {
    // Handlers read the body; give each its own copy so the legacy path below still can.
    const handled = await group({ ...ctx, request: request.clone() as typeof request });
    if (handled) return handled;
  }
  if (!requireV1Read(principal)) return v1Forbidden();
  const match = url.pathname.match(/^\/api\/v1\/(threads|reviews)(?:\/([^/]+)(?:\/(message|interrupt|archive|tasks))?)?$/);
  if (!match || (match[1] === "reviews" && match[2])) return Response.json({ error: "Not found." }, { status: 404 });
  const [, resource, encodedId, action] = match;
  const expectedMethod = action && action !== "tasks" ? "POST" : undefined;
  if (expectedMethod ? request.method !== expectedMethod : request.method !== "GET" && (request.method !== "POST" || encodedId)) {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  if (action === "tasks" && request.method !== "GET") return Response.json({ error: "Method not allowed." }, { status: 405 });
  let id: string | undefined;
  try { id = encodedId ? decodeURIComponent(encodedId) : undefined; }
  catch { return Response.json({ error: "Invalid thread id." }, { status: 400 }); }
  let body: Record<string, unknown> = {};
  if (request.method === "POST" && (!action || action === "message")) {
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch { return Response.json({ error: "Invalid request body." }, { status: 400 }); }
  }
  if (body.session !== undefined) {
    if (typeof body.session !== "string") return Response.json({ error: "Invalid session id." }, { status: 400 });
    if (!url.searchParams.has("session")) url.searchParams.set("session", body.session);
  }
  const resolved = await (deps.resolveTarget ?? resolveRunStoreTarget)(request, env, url);
  if ("error" in resolved) return resolved.error;
  const stub = await (deps.getStub ?? (async (bindings, name) => getAgentByName(bindings.CodingOrchestrator, name)))(env, resolved.agentName);
  const forward = async (method: string, path: string, input?: Record<string, unknown>) => {
    const headers = new Headers(request.headers);
    headers.delete(LOCAL_INTAKE_HEADER);
    headers.set(LOCAL_INTAKE_HEADER, LOCAL_INTAKE_DASHBOARD);
    headers.delete(AGENT_PRINCIPAL_HEADER);
    headers.delete("content-length");
    if (input) headers.set("content-type", "application/json");
    const internal = new Request(new URL(path, request.url), {
      method, headers, ...(input ? { body: JSON.stringify(input) } : {}),
    });
    await signInternalRequest(internal, env);
    return stub.fetch(internal);
  };
  const path = id ? `/api/runs/${encodeURIComponent(id)}` : "/api/runs";
  if (request.method === "GET" && !id) {
    const response = await forward("GET", path);
    if (!response.ok) return response;
    const { runs } = await response.json() as { runs: DelegatedRun[] };
    return Response.json(resource === "reviews"
      ? { reviews: runs.filter((run) => laneForRun(run) === "needs_review" && run.archivedAt === undefined).map(v1Thread) }
      : { threads: runs.map(v1Thread) });
  }
  if (id && action !== "message") {
    const response = await forward(action === "interrupt" ? "DELETE" : action === "archive" ? "POST" : "GET", action === "archive" ? `${path}/archive` : path);
    if (!response.ok) return response;
    const { run } = await response.json() as { run: DelegatedRun };
    return Response.json(action === "tasks" ? { tasks: v1Tasks(run) } : { thread: v1Thread(run) });
  }
  if (action === "message" && id) {
    if (typeof body.text !== "string" || !body.text.trim()) return Response.json({ error: "text is required." }, { status: 400 });
    const response = await forward("GET", path);
    if (!response.ok) return response;
    const { run } = await response.json() as { run: DelegatedRun & { threadKey?: string } };
    if (run.status === "pending" || run.status === "running") {
      return Response.json({ error: "Only one active run per thread is allowed." }, { status: 409 });
    }
    const queued = await forward(
      "POST",
      "/api/runs",
      v1RunQueueBody(principal, {
        repoUrl: run.repoUrl,
        task: `Follow-up on run ${id}:\n${body.text}`,
        ...(run.threadKey ? { threadKey: run.threadKey } : {}),
        ...(run.continuationKey ? { continuesKey: run.continuationKey } : {}),
      }),
    );
    if (!queued.ok) return queued;
    return Response.json({ ...await queued.json() as object, threadId: id }, { status: queued.status });
  }
  if (request.method === "POST" && !id && !requireV1Write(principal)) {
    return v1Forbidden();
  }
  if (action === "message" && !requireV1Write(principal)) {
    return v1Forbidden();
  }
  if (resource === "reviews") {
    if (typeof body.repoUrl !== "string" || !body.repoUrl.trim() || typeof body.pullNumber !== "number" || !Number.isInteger(body.pullNumber) || body.pullNumber < 1 || (body.headSha !== undefined && typeof body.headSha !== "string")) {
      return Response.json({ error: "repoUrl and a positive pullNumber are required." }, { status: 400 });
    }
    const repo = body.repoUrl.replace(/\/$/, "");
    return forward(
      "POST",
      "/api/runs",
      v1RunQueueBody(principal, {
        repoUrl: body.repoUrl,
        task: reviewerTask({
          repoUrl: body.repoUrl,
          pullNumber: body.pullNumber,
          headSha: body.headSha ?? "head",
          diffUrl: `${repo}/pull/${body.pullNumber}.diff`,
        }),
        publishPullRequest: false,
        role: "reviewer",
        codingModel: env.REVIEW_RUN_MODEL?.trim() || "opencode-go/gpt-6.1-sol",
        commandId: `v1review:${body.repoUrl}:${body.pullNumber}:${body.headSha ?? "head"}`,
      }),
    );
  }
  const repoUrl =
    typeof body.repoUrl === "string" && body.repoUrl.trim()
      ? body.repoUrl.trim()
      : typeof body.projectId === "string"
        ? body.projectId.trim()
        : "";
  const task =
    typeof body.task === "string" && body.task.trim()
      ? body.task.trim()
      : typeof body.message === "string"
        ? body.message.trim()
        : "";
  if (!repoUrl || !task) {
    return Response.json({ error: "repoUrl (or projectId) and task (or message) are required." }, { status: 400 });
  }
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (requestId) {
    const prior = await readThreadCreateReceipt(env, principal.orgId, requestId);
    if (prior) {
      return Response.json({
        id: prior.threadId ?? prior.approvalId,
        threadId: prior.threadId ?? null,
        approvalId: prior.approvalId,
        deduped: true,
        status: prior.threadId ? "queued" : "waiting",
      });
    }
  }
  const input: Record<string, unknown> = { repoUrl, task };
  for (const key of ["baseBranch", "publishPullRequest", "harness", "codingModel", "reasoningEffort", "runSetup", "role", "reviewAfterPublish"]) {
    if (body[key] !== undefined) input[key] = body[key];
  }
  if (requestId) {
    input.commandId = await threadCreateCommandId(principal.orgId, requestId);
  }
  const queued = await forward("POST", "/api/runs", v1RunQueueBody(principal, input));
  if (!queued.ok) return queued;
  const result = await queued.json() as { approvalId?: string; deduped?: boolean; runId?: string };
  if (requestId && result.approvalId) {
    await writeThreadCreateReceipt(env, principal.orgId, requestId, {
      approvalId: result.approvalId,
      at: Date.now(),
      ...(result.deduped ? { deduped: true } : {}),
    });
  }
  return Response.json({
    id: result.runId ?? result.approvalId,
    approvalId: result.approvalId,
    deduped: result.deduped === true,
    status: "waiting",
  }, { status: queued.status });
}
