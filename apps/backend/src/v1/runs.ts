import { isActiveStatus, type DelegatedRun } from "@shiba/shared";
import { publicRunMessage, runTimedOut } from "../public-error.js";
import type { V1Context } from "./context.js";

export function runStatus(run: DelegatedRun) {
  switch (run.status) {
    case "pending": return "queued";
    case "running": return "running";
    case "completed": return "completed";
    case "cancelled": case "aborted": return "cancelled";
    default: return "failed";
  }
}

export async function readRun(ctx: V1Context, id: string): Promise<DelegatedRun | Response> {
  const response = await ctx.forward("GET", `/api/runs/${encodeURIComponent(id)}`);
  if (!response.ok) return response;
  return (await response.json() as { run: DelegatedRun }).run;
}

export function runMessages(run: DelegatedRun) {
  const messages = [{ id: `${run.runId}:user`, threadId: run.runId, runId: run.runId,
    role: "user", kind: "chat", content: run.task, createdAt: new Date(run.createdAt).toISOString() }];
  if (run.summary) messages.push({ id: `${run.runId}:assistant`, threadId: run.runId, runId: run.runId,
    role: "assistant", kind: "chat", content: run.summary, createdAt: new Date(run.updatedAt).toISOString() });
  return messages;
}

export function runActivity(run: DelegatedRun) {
  // Pipeline milestones are the only activity persisted by the current registry.
  return (run.signals ?? []).map((signal, index) => ({ kind: "tool" as const,
    id: `${run.runId}:signal:${index}`, threadId: run.runId, runId: run.runId,
    toolName: signal.kind, status: "completed", createdAt: new Date(signal.at).toISOString(),
    description: signal.kind }));
}

export async function handleRuns(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/(runs(?:\/([^/]+)\/(failure|activity(?:\/bounds)?))?|run-state|active-run|stop|retry)$/);
  if (!match) return null;
  const action = match[4] ?? match[2];
  const method = action === "stop" || action === "retry" ? "POST" : "GET";
  if (ctx.request.method !== method) return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  let id: string;
  let runId: string | undefined;
  try { id = decodeURIComponent(match[1]!); runId = match[3] ? decodeURIComponent(match[3]) : undefined; }
  catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
  // Until threads have their own registry, a thread owns exactly its namesake run.
  if (runId !== undefined && runId !== id) return Response.json({ ok: false, error: "run_not_found" }, { status: 404 });
  const run = await readRun(ctx, id);
  if (run instanceof Response) return run;
  const status = runStatus(run);
  const finishedAt = isActiveStatus(run.status) ? null : new Date(run.updatedAt).toISOString();
  if (action === "run-state") {
    const messages = runMessages(run);
    return Response.json({ ok: true, run: { runId: id, status, finishedAt,
      userMessage: messages[0], assistantMessage: messages[1] ?? null } });
  }
  if (action === "active-run") return Response.json({ ok: true,
    activeRun: isActiveStatus(run.status) ? { runId: id, status } : null });
  if (action === "runs") {
    const limit = ctx.url.searchParams.get("limit");
    if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
      return Response.json({ ok: false, error: "invalid_limit" }, { status: 400 });
    }
    if (ctx.url.searchParams.has("cursor")) return Response.json({ ok: false, error: "invalid_cursor" }, { status: 400 });
    return Response.json({ ok: true, nextCursor: null, runs: [{ id, threadId: id, status,
      createdAt: new Date(run.createdAt).toISOString(),
      startedAt: run.signals?.find((signal) => signal.kind === "harness.started")?.at !== undefined
        ? new Date(run.signals.find((signal) => signal.kind === "harness.started")!.at).toISOString() : null,
      finishedAt }] });
  }
  if (action === "failure") {
    if (status !== "failed") return Response.json({ ok: false, error: "run_failure_not_found" }, { status: 404 });
    return Response.json({
      ok: true,
      detail: {
        code: run.errorCode ?? "unknown",
        message: publicRunMessage(run) ?? "Sorry, an error occurred",
        timedOut: runTimedOut(run),
      },
    });
  }
  if (action === "activity" || action === "activity/bounds") {
    const items = runActivity(run);
    const firstActivityAt = items[0]?.createdAt ?? null;
    const lastActivityAt = items.at(-1)?.createdAt ?? null;
    const durationMs = firstActivityAt && lastActivityAt ? Math.max(0, Date.parse(lastActivityAt) - Date.parse(firstActivityAt)) : null;
    if (action === "activity/bounds") return Response.json({ ok: true, bounds: { firstActivityAt, lastActivityAt, durationMs } });
    const limitRaw = ctx.url.searchParams.get("limit") ?? "100";
    const cursor = ctx.url.searchParams.get("cursor");
    const pagination = ctx.url.searchParams.get("pagination");
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100 || (pagination !== null && pagination !== "cursor")) {
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    const offset = cursor === null ? 0 : items.findIndex((item) => item.id === cursor) + 1;
    if (cursor !== null && offset === 0) return Response.json({ ok: false, error: "invalid_cursor" }, { status: 400 });
    const page = items.slice(offset, offset + Number(limitRaw));
    const hasMore = offset + page.length < items.length;
    return Response.json({ ok: true, items: page, hasMore, nextCursor: hasMore ? page.at(-1)!.id : null,
      activitySpanDurationMs: durationMs, activeDurationMs: null, activeDurationProvenance: "unknown" });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await ctx.request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch { return Response.json({ ok: false, error: "invalid_request" }, { status: 400 }); }
  if (body.clientOperationId !== undefined && (typeof body.clientOperationId !== "string" || !body.clientOperationId.trim() || body.clientOperationId.length > 64)) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  if (action === "stop") {
    if (typeof body.runId !== "string" || !body.runId) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    if (body.runId !== id) return Response.json({ ok: false, error: "run_not_found" }, { status: 404 });
    const response = await ctx.forward("DELETE", `/api/runs/${encodeURIComponent(id)}`);
    if (!response.ok) return response;
    const stopped = (await response.json() as { run: DelegatedRun }).run;
    return Response.json({ ok: true, result: { threadId: id, runId: id, status: runStatus(stopped) } }, { status: 202 });
  }
  if (isActiveStatus(run.status)) return Response.json({ ok: false, error: "run_active" }, { status: 409 });
  // T68: a finished run's sealed env is discarded, so a retry can't carry it — refuse rather than run without it.
  if (run.envDigest !== undefined) return Response.json({ ok: false, error: "environment_discarded" }, { status: 409 });
  const key = ctx.request.headers.get("Idempotency-Key") ?? body.clientOperationId;
  if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 128)) {
    return Response.json({ ok: false, error: "invalid_idempotency_key" }, { status: 400 });
  }
  const { v1RunQueueBody } = await import("./run-intake.js");
  const response = await ctx.forward(
    "POST",
    "/api/runs",
    v1RunQueueBody(ctx.principal, {
      repoUrl: run.repoUrl,
      task: run.task,
      baseBranch: run.baseBranch,
      publishPullRequest: run.publishPullRequest,
      ...(run.route
        ? { harness: run.route.harness, codingModel: run.route.modelId, connectionId: run.route.connectionId }
        : {}),
      ...(run.route?.reasoningEffort ? { reasoningEffort: run.route.reasoningEffort } : {}),
      ...(run.runSetup === true ? { runSetup: true } : {}),
      ...(run.authAccount ? { authAccount: run.authAccount } : {}),
      ...(run.runtime ? { runtime: run.runtime } : {}),
      ...(run.targetMachineId ? { targetMachineId: run.targetMachineId } : {}),
      ...(run.testCommand ? { testCommand: run.testCommand } : {}),
      ...(key ? { commandId: `v1:retry:${id}:${key}` } : {}),
    }),
  );
  if (!response.ok) return response;
  const queued = await response.json() as { approvalId?: string };
  return Response.json({ ok: true, result: { threadId: id, status: "waiting", approvalId: queued.approvalId } }, { status: 202 });
}
