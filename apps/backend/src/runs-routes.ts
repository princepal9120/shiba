/**
 * `/api/runs` — the dashboard's run registry, proxied to the caller's
 * CodingOrchestrator DO (or a session DO when ?session= names one).
 * Extracted from index.ts; the per-surface Access gate stays here.
 */
import { getAgentByName } from "agents/routing";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_DASHBOARD, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import type { Env } from "./env.js";
import { signInternalRequest } from "./edge-identity.js";

import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { sealRunEnv } from "./run-env-seal.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import {
  buildSessionAgentName,
  DEFAULT_SESSION_ID,
  isValidSessionId,
} from "./web-sessions.js";

/**
 * Which orchestrator DO holds the caller's run records: `?session=`/`?sessionId=`
 * resolves to that session's agent (verified against the user DO first);
 * absent — or the literal "default" — the caller's own user DO. Shared by
 * handleRuns and the /api/usage aggregate reader.
 */
export async function resolveRunStoreTarget(
  request: Request,
  env: Env,
  url: URL,
): Promise<{ agentName: string; userId: string } | { error: Response }> {
  // Local development shares the same fallback as the dashboard identity endpoint.
  const userId = (await resolveUserId(request, env)) ?? "default";
  const sessionParam = url.searchParams.get("session") || url.searchParams.get("sessionId");
  if (sessionParam && sessionParam !== DEFAULT_SESSION_ID) {
    if (!isValidSessionId(sessionParam)) {
      return { error: Response.json({ error: "Invalid session id." }, { status: 400 }) };
    }
    const userStub = await getAgentByName(env.CodingOrchestrator, userId);
    const sessionCheck = await userStub.fetch(
      `https://internal/internal/web-sessions/${encodeURIComponent(sessionParam)}`,
    );
    if (sessionCheck.status === 404) {
      return { error: Response.json({ error: "Session not found." }, { status: 404 }) };
    }
    if (!sessionCheck.ok) {
      return { error: Response.json({ error: "Failed to verify session." }, { status: sessionCheck.status }) };
    }
    return { agentName: buildSessionAgentName(userId, sessionParam), userId };
  }
  return { agentName: userId, userId };
}

type RunSummary = { runId: string; createdAt?: number };

/**
 * Automations, the review lane, Sentry and Slash runs live on the shared
 * "default" DO. Unscoped run reads by a DASHBOARD_APPROVERS member (the set
 * that can approve those runs) also read it; everyone else sees only their
 * own DO, so one user's runs never leak into another's list.
 */
async function withSharedRuns(
  env: Env,
  own: Response,
  runId: string | null,
  limitParam: string | null,
): Promise<Response> {
  const shared = await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME);
  if (runId !== null) {
    if (own.status !== 404) return own;
    const fallback = await shared.fetch(`https://internal/api/runs/${encodeURIComponent(runId)}`);
    return fallback.ok ? fallback : own;
  }
  if (!own.ok) return own;
  const sharedRes = await shared.fetch(
    `https://internal/api/runs${limitParam !== null ? `?limit=${encodeURIComponent(limitParam)}` : ""}`,
  );
  if (!sharedRes.ok) return own;
  const mine = ((await own.json().catch(() => ({}))) as { runs?: RunSummary[] }).runs ?? [];
  const theirs = ((await sharedRes.json().catch(() => ({}))) as { runs?: RunSummary[] }).runs ?? [];
  const seen = new Set(mine.map((run) => run.runId));
  const merged = [...mine, ...theirs.filter((run) => !seen.has(run.runId))];
  // Same order contract as the DO: oldest-first, or newest-first when bounded.
  if (limitParam === null) {
    merged.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return Response.json({ runs: merged });
  }
  merged.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return Response.json({ runs: merged.slice(0, Math.min(Number(limitParam), 500)) });
}

export async function handleRuns(request: Request, env: Env): Promise<Response | null> {
  const res = await handleRunsInner(request, env);
  if (res === null) return null;
  // Run state is live: every response (errors included) is no-store; re-wrap since stub.fetch headers may be immutable.
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-store");
  return out;
}

async function handleRunsInner(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  // /api/spine rides this lane: the orchestrator's P9 event log + outbox
  // live on the same DO, behind the same dashboard auth and session scope.
  const isSpine = url.pathname === "/api/spine";
  // The DO serves two-segment subroutes under /api/runs/<id>/: fork, screen.
  if (
    !isSpine &&
    !/^\/api\/runs(?:\/[^/]+(?:\/(?:fork|screen|archive|steer|subagents))?|\/subagents\/spawn)?$/.test(
      url.pathname,
    )
  ) {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (isSpine && request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const isSteer = /^\/api\/runs\/[^/]+\/steer$/.test(url.pathname);
  if (
    !isSpine &&
    request.method !== "GET" &&
    request.method !== "DELETE" &&
    request.method !== "POST"
  ) {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  if (isSteer && request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) {
    return resolved.error;
  }
  let targetAgentName = resolved.agentName;
  // T68: seal per-run env values for the same DO the follow-up queue/chat lands on;
  // the sealed blob is the only form the values travel in from here.
  if (url.pathname === "/api/runs/env-seal") {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
    const body = (await request.json().catch(() => null)) as { environmentVariables?: unknown } | null;
    try {
      return Response.json(await sealRunEnv(env, resolved.agentName, body?.environmentVariables));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid environment variables." }, { status: 400 });
    }
  }
  // Email-kind approvals freeze draft claims + mailbox payloads, and claim
  // recovery (releaseRestartedDraftClaim, sweepStaleDrafts, Slack resolve)
  // assumes they live on the one shared instance queueEmailApproval pins —
  // minting them on a per-user DO leaves a record no sweep can see.
  if (request.method === "POST") {
    const kind = await request.clone().json().then(
      (body) => (typeof body === "object" && body !== null ? (body as { kind?: unknown }).kind : undefined),
      () => undefined,
    );
    if (kind === "email_send" || kind === "email_delete") {
      targetAgentName = ORCHESTRATOR_NAME;
    }
  }
  const stub = await getAgentByName(env.CodingOrchestrator, targetAgentName);
  const rewritten = new Request(new URL(url.pathname + url.search, request.url), request);
  // T51: the intake voucher. Any inbound copy is replaced by the only value
  // this Worker ever stamps — a run carrying `runtime: "local"` is provably
  // dashboard-originated when queueSlackRun reads this header. Internal
  // surfaces (Slack, email, MCP, automations) post through
  // `https://internal` and never carry it.
  rewritten.headers.delete(LOCAL_INTAKE_HEADER);
  rewritten.headers.set(LOCAL_INTAKE_HEADER, LOCAL_INTAKE_DASHBOARD);
  // Same strip for the agent-principal voucher: the DO reads queuedBy and
  // the /api/spine filter from this header as worker-vouched. Only
  // mcp-run-tools stamps it, on internal stub calls — never on this lane,
  // so an inbound copy is a forgery, not a credential to forward.
  rewritten.headers.delete(AGENT_PRINCIPAL_HEADER);
  // Edge identity: sign the stamped intake voucher so the DO can verify the
  // Worker minted it (no-op until INTERNAL_SIGNING_KEY is configured).
  await signInternalRequest(rewritten, env);
  const response = await stub.fetch(rewritten);
  const runMatch = url.pathname.match(/^\/api\/runs(?:\/([^/]+))?$/);
  if (
    !isSpine &&
    request.method === "GET" &&
    runMatch &&
    targetAgentName === resolved.userId &&
    targetAgentName !== ORCHESTRATOR_NAME &&
    isApprover(resolved.userId, parseApproverAllowlist(env.DASHBOARD_APPROVERS))
  ) {
    let runId: string | null;
    try {
      runId = runMatch[1] ? decodeURIComponent(runMatch[1]) : null;
    } catch {
      return response;
    }
    return withSharedRuns(env, response, runId, url.searchParams.get("limit"));
  }
  return response;
}
