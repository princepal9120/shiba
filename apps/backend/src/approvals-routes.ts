import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { DECIDED_APPROVALS_LIMIT, type PendingApproval } from "./pending-approvals.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { jsonObjectBody } from "./route-utils.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import {
  buildSessionAgentName,
  isAuthorizedSessionAgent,
  isValidSessionId,
  WEB_SESSION_PREFIX,
  type WebSessionRecord,
} from "./web-sessions.js";

/**
 * Approval pointers live on the orchestrator Durable Object, not the
 * worker: every email approval mints on `"default"` and dashboard-queued
 * runs mint on the caller's instance. Listing fans out to both stubs and
 * merges; resolving probes the caller's DO first, then `"default"` — an
 * `"unknown"` reply means "try the next stub", never a verdict.
 *
 * Decider gate: any Access-authenticated identity — the megaplan's "same
 * Access-auth gate as /api/runs" for every dashboard surface. The Slack
 * surface is deliberately stricter (SLACK_APPROVERS allowlist) because a
 * Slack workspace admits people the Access policy never vetted.
 */
export async function handleApprovals(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/approvals") {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const userId = (await resolveUserId(request, env)) ?? ORCHESTRATOR_NAME;
  const userStub = await getAgentByName(env.CodingOrchestrator, userId);
  let sessionAgentNames: string[] = [];
  try {
    const listRes = await userStub.fetch("https://internal/internal/web-sessions");
    if (listRes.ok) {
      const body = (await listRes.json().catch(() => ({}))) as { sessions?: WebSessionRecord[] };
      // Never trust a stored record's agentName: a forged registry entry
      // (e.g. via a client state write on a pre-hardening DO) could name
      // another user's DO or the default instance, and the fan-out below
      // would then expose or resolve that DO's approvals. Recompute each
      // fan-out target from the authenticated owner + the record's
      // server-minted session UUID.
      sessionAgentNames = (body.sessions ?? [])
        .filter((s) => s.userId === userId && isValidSessionId(s.id))
        .map((s) => buildSessionAgentName(userId, s.id));
    }
  } catch {
    // Non-fatal if listing fails
  }
  const names = [...new Set([userId, ...sessionAgentNames, ORCHESTRATOR_NAME])];
  const stubs = await Promise.all(
    names.map((name) => getAgentByName(env.CodingOrchestrator, name)),
  );
  if (request.method === "GET") {
    const seen = new Map<string, PendingApproval>();
    const decidedSeen = new Map<string, PendingApproval>();
    for (const stub of stubs) {
      const response = await stub.fetch(new Request("https://internal/api/approvals"));
      if (!response.ok) {
        console.warn(`GET /api/approvals probe failed (${response.status})`);
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as {
        approvals?: PendingApproval[];
        decided?: PendingApproval[];
      };
      for (const approval of body.approvals ?? []) {
        seen.set(approval.approvalId, approval);
      }
      for (const approval of body.decided ?? []) {
        decidedSeen.set(approval.approvalId, approval);
      }
    }
    const approvals = [...seen.values()].sort((a, b) => a.createdAt - b.createdAt);
    const decided = [...decidedSeen.values()]
      .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
      .slice(0, DECIDED_APPROVALS_LIMIT);
    return Response.json({ approvals, decided }, { headers: { "Cache-Control": "no-store" } });
  }
  if (request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await jsonObjectBody(request);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid request body." },
        { status: 400 },
      );
    }
    if (typeof body.threadKey !== "string" || typeof body.approvalId !== "string" || typeof body.approved !== "boolean") {
      return Response.json({ error: "Invalid approval payload." }, { status: 400 });
    }
    const decidedBy = (await resolveUserId(request, env)) ?? "default";
    if (body.threadKey.startsWith(WEB_SESSION_PREFIX)) {
      if (!isAuthorizedSessionAgent(body.threadKey, decidedBy)) {
        return Response.json({ error: "Forbidden." }, { status: 403 });
      }
      if (!sessionAgentNames.includes(body.threadKey)) {
        return Response.json({ error: "Session not found." }, { status: 404 });
      }
    }
    let probeFailure: Response | null = null;
    for (const stub of stubs) {
      const response = await stub.fetch(
        new Request("https://internal/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadKey: body.threadKey,
            approvalId: body.approvalId,
            approved: body.approved,
            decidedBy,
            source: "dashboard",
          }),
        }),
      );
      // A stub's transport failure is not a verdict — the pointer may
      // live on the next stub, so keep probing like the GET fan-out.
      if (!response.ok) {
        console.warn(`POST /api/approvals probe failed (${response.status})`);
        probeFailure ??= response;
        continue;
      }
      const result = (await response.json().catch(() => ({}))) as { result?: string };
      if (result.result !== "unknown") {
        return Response.json({ result: result.result });
      }
    }
    // No decisive answer: a probe failure means "retry", never the
    // misleading "unknown" a healthy-but-uninvolved stub would imply.
    // The consumed probe response can't be re-serialized to the client,
    // so the unknown verdict is rebuilt here.
    return probeFailure ?? Response.json({ result: "unknown" });
  }
  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
