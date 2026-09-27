/**
 * `/api/runs` — the dashboard's run registry, proxied to the caller's
 * CodingOrchestrator DO (or a session DO when ?session= names one).
 * Extracted from index.ts; the per-surface Access gate stays here.
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { getUserId, isAuthenticated } from "./request-auth.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import {
  buildSessionAgentName,
  DEFAULT_SESSION_ID,
  isValidSessionId,
} from "./web-sessions.js";

export async function handleRuns(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/^\/api\/runs(?:\/[^/]+)?$/.test(url.pathname)) {
    return null;
  }
  if (!isAuthenticated(request, env)) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "GET" && request.method !== "DELETE" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  // Local development shares the same fallback as the dashboard identity endpoint.
  const userId = getUserId(request) ?? "default";
  let targetAgentName = userId;
  const sessionParam = url.searchParams.get("session") || url.searchParams.get("sessionId");
  if (sessionParam && sessionParam !== DEFAULT_SESSION_ID) {
    if (!isValidSessionId(sessionParam)) {
      return Response.json({ error: "Invalid session id." }, { status: 400 });
    }
    const userStub = await getAgentByName(env.CodingOrchestrator, userId);
    const sessionCheck = await userStub.fetch(
      `https://internal/internal/web-sessions/${encodeURIComponent(sessionParam)}`,
    );
    if (sessionCheck.status === 404) {
      return Response.json({ error: "Session not found." }, { status: 404 });
    }
    if (!sessionCheck.ok) {
      return Response.json({ error: "Failed to verify session." }, { status: sessionCheck.status });
    }
    targetAgentName = buildSessionAgentName(userId, sessionParam);
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
  return stub.fetch(rewritten);
}
