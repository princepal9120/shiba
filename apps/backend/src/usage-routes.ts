/**
 * `GET /api/usage` — daily token/cost aggregates over the same orchestrator
 * DO run store `/api/runs` serves (or a session DO when `?session=` names
 * one). Mirrors handleRuns' auth and session scoping; the DO stays the only
 * run-writing surface, so aggregation reads its records Worker-side.
 * `USAGE_BUDGET_USD` supplies the optional daily budget line.
 */
import { getAgentByName } from "agents/routing";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { resolveRunStoreTarget } from "./runs-routes.js";
import { buildUsageReport, parseUsageDays } from "./usage.js";

export async function handleUsage(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/usage") {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) {
    return resolved.error;
  }
  const stub = await getAgentByName(env.CodingOrchestrator, resolved.agentName);
  // The DO answers /api/runs with the same scoping the dashboard list gets;
  // usage aggregates those records — the DO's write surface is untouched.
  const runsRequest = new Request(new URL("/api/runs", request.url), request);
  // Same strip as handleRuns: the clone carries the caller's headers into
  // the DO, where X-Agent-Principal (queuedBy + the /api/spine filter) and
  // X-Shiba-Intake (the local-runtime voucher) read as worker-vouched. This
  // lane forwards a read, never credentials — an inbound copy is a forgery.
  runsRequest.headers.delete(AGENT_PRINCIPAL_HEADER);
  runsRequest.headers.delete(LOCAL_INTAKE_HEADER);
  const runsResponse = await stub.fetch(runsRequest);
  if (!runsResponse.ok) {
    return runsResponse;
  }
  const body = (await runsResponse.json()) as { runs?: DelegatedRun[] };
  const report = buildUsageReport(Array.isArray(body.runs) ? body.runs : [], env, {
    days: parseUsageDays(url.searchParams.get("days")),
  });
  return Response.json(report);
}
