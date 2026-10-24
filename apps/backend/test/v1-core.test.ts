import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";
import type { Env } from "../src/env.js";
import type { V1Context } from "../src/v1/context.js";
import { handleMessages } from "../src/v1/messages.js";
import { handleRuns } from "../src/v1/runs.js";
import { handleThreads } from "../src/v1/threads.js";
import { handleSystem } from "../src/v1/system.js";

const run: DelegatedRun = { runId: "r1", sandboxId: "s1", repoUrl: "https://github.com/acme/repo", task: "Fix bugs",
  baseBranch: "main", publishPullRequest: false, generation: 2, status: "completed", createdAt: 1000, updatedAt: 4000,
  summary: "Fixed bugs", signals: [{ kind: "sandbox.ready", at: 2000 }, { kind: "harness.started", at: 3000 }] };

function fixture(path: string, method = "GET", body?: unknown, current = run) {
  const request = new Request(`https://worker.test/api/v1${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const forward = vi.fn(async (verb: string, route: string, _input?: Record<string, unknown>) => {
    if (verb === "DELETE") return Response.json({ run: { ...current, status: "cancelled" } });
    if (route.endsWith("/archive")) return Response.json({ run: { ...current, archivedAt: 5000 } });
    if (verb === "POST") return Response.json({ ok: true, approvalId: "a1" });
    return Response.json({ run: current });
  });
  const ctx: V1Context = {
    request, url: new URL(request.url), env: {} as Env, forward,
    principal: { principal: "test", orgId: "self-hosted", scopes: ["api:read", "api:write", "api:keys:admin"] },
  };
  return { ctx, forward };
}

describe("v1 core run facade", () => {
  it("returns null for unrelated groups", async () => {
    for (const handler of [handleRuns, handleMessages, handleThreads, handleSystem]) expect(await handler(fixture("/unrelated").ctx)).toBeNull();
  });
  it.each([["pending", "queued"], ["running", "running"], ["error", "failed"], ["unknown", "failed"], ["aborted", "cancelled"], ["completed", "completed"]] as const)("maps %s without inventing start timestamps", async (status, expected) => {
    const response = await handleRuns(fixture("/threads/r1/runs", "GET", undefined, { ...run, status, signals: [] }).ctx);
    expect(await response!.json()).toMatchObject({ ok: true, runs: [{ id: "r1", threadId: "r1", status: expected, startedAt: null }] });
  });
  it("returns state and no active run after completion", async () => {
    expect(await (await handleRuns(fixture("/threads/r1/run-state").ctx))!.json()).toMatchObject({ run: { status: "completed", userMessage: { content: "Fix bugs" }, assistantMessage: { content: "Fixed bugs" } } });
    expect(await (await handleRuns(fixture("/threads/r1/active-run").ctx))!.json()).toEqual({ ok: true, activeRun: null });
  });
  it("rejects a foreign run before looking it up", async () => {
    const f = fixture("/threads/r1/runs/r2/failure");
    expect((await handleRuns(f.ctx))!.status).toBe(404);
    expect(f.forward).not.toHaveBeenCalled();
  });
  it("propagates missing thread responses", async () => {
    const f = fixture("/threads/missing/active-run");
    f.forward.mockResolvedValue(Response.json({ error: "missing" }, { status: 404 }));
    expect((await handleRuns(f.ctx))!.status).toBe(404);
  });
  it("validates stop ownership and delegates cancellation", async () => {
    expect((await handleRuns(fixture("/threads/r1/stop", "POST", { runId: "r2" }).ctx))!.status).toBe(404);
    expect((await handleRuns(fixture("/threads/r1/stop", "POST", {}).ctx))!.status).toBe(400);
    const f = fixture("/threads/r1/stop", "POST", { runId: "r1" });
    expect(await (await handleRuns(f.ctx))!.json()).toMatchObject({ result: { runId: "r1", status: "cancelled" } });
    expect(f.forward).toHaveBeenLastCalledWith("DELETE", "/api/runs/r1");
  });
  it("queues retries through the approval gate with an endpoint-scoped idempotency key", async () => {
    const f = fixture("/threads/r1/retry", "POST", { clientOperationId: "once" });
    const response = await handleRuns(f.ctx);
    expect(response!.status).toBe(202);
    expect(await response!.json()).toEqual({ ok: true, result: { threadId: "r1", status: "waiting", approvalId: "a1" } });
    expect(f.forward).toHaveBeenLastCalledWith("POST", "/api/runs", expect.objectContaining({ task: run.task, repoUrl: run.repoUrl, commandId: "v1:retry:r1:once" }));
  });
  it("refuses active retries and malformed bodies", async () => {
    expect((await handleRuns(fixture("/threads/r1/retry", "POST", {}, { ...run, status: "running" }).ctx))!.status).toBe(409);
    expect((await handleRuns(fixture("/threads/r1/retry", "POST", []).ctx))!.status).toBe(400);
  });
  it("T68: refuses to retry a finished run whose env was discarded, rather than running without it", async () => {
    const f = fixture("/threads/r1/retry", "POST", {}, { ...run, envNames: ["DATABASE_URL"], envDigest: "d".repeat(64) });
    const response = await handleRuns(f.ctx);
    expect(response!.status).toBe(409);
    expect(await response!.json()).toEqual({ ok: false, error: "environment_discarded" });
    expect(f.forward).not.toHaveBeenCalledWith("POST", "/api/runs", expect.anything());
  });
  it("carries the effort and the setup opt-in onto a retry", async () => {
    const effortRoute = { ...(run.route ?? { purpose: "coding", connectionId: null, modelId: "openai/gpt-5", harness: "codex", policyVersion: 0 }), reasoningEffort: "high" as const };
    const f = fixture("/threads/r1/retry", "POST", {}, { ...run, route: effortRoute, runSetup: true });
    expect((await handleRuns(f.ctx))!.status).toBe(202);
    expect(f.forward).toHaveBeenLastCalledWith("POST", "/api/runs", expect.objectContaining({ reasoningEffort: "high", runSetup: true }));
  });
  it("paginates real milestones without claiming measured active duration", async () => {
    const first = await (await handleRuns(fixture("/threads/r1/runs/r1/activity?limit=1&pagination=cursor").ctx))!.json() as { nextCursor: string };
    expect(first).toMatchObject({ hasMore: true, activeDurationMs: null, activeDurationProvenance: "unknown", items: [{ toolName: "sandbox.ready" }] });
    const next = await (await handleRuns(fixture(`/threads/r1/runs/r1/activity?cursor=${first.nextCursor}`).ctx))!.json();
    expect(next).toMatchObject({ hasMore: false, items: [{ toolName: "harness.started" }] });
    expect(await (await handleRuns(fixture("/threads/r1/runs/r1/activity/bounds").ctx))!.json()).toMatchObject({ bounds: { durationMs: 1000 } });
    expect((await handleRuns(fixture("/threads/r1/runs/r1/activity?cursor=foreign").ctx))!.status).toBe(400);
  });
  it("does not disclose raw failure payloads", async () => {
    const failed = { ...run, status: "error" as const, error: "secret-token", errorCode: "internal_error" as const };
    const response = await handleRuns(fixture("/threads/r1/runs/r1/failure", "GET", undefined, failed).ctx);
    expect(await response!.text()).not.toContain("secret-token");
    expect((await handleRuns(fixture("/threads/r1/runs/r1/failure").ctx))!.status).toBe(404);
  });
});

describe("v1 messages and thread mutations", () => {
  it("paginates the stored task and summary backward", async () => {
    const first = await (await handleMessages(fixture("/threads/r1/messages?limit=1").ctx))!.json() as { nextCursor: string };
    expect(first).toMatchObject({ hasMore: true, messages: [{ role: "assistant", content: run.summary }] });
    const next = await (await handleMessages(fixture(`/threads/r1/messages?cursor=${first.nextCursor}`).ctx))!.json();
    expect(next).toMatchObject({ hasMore: false, messages: [{ role: "user", content: run.task }] });
    expect((await handleMessages(fixture("/threads/r1/messages?cursor=bad").ctx))!.status).toBe(400);
    expect((await handleMessages(fixture("/threads/r1/messages?limit=0").ctx))!.status).toBe(400);
  });
  it("exports JSON and Markdown from persisted data only", async () => {
    const response = await handleMessages(fixture("/threads/r1/export?format=json&level=activity").ctx);
    expect(await response!.json()).toMatchObject({ schemaVersion: 1, thread: { id: "r1" }, runs: [{ entries: [{ type: "message" }, { type: "message" }, { type: "tool_call" }, { type: "tool_call" }] }] });
    const markdown = await handleMessages(fixture("/threads/r1/export").ctx);
    expect(markdown!.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown!.text()).toContain("Fixed bugs");
    expect((await handleMessages(fixture("/threads/r1/export?level=full").ctx))!.status).toBe(501);
  });
  it("archives through the existing durable mutation", async () => {
    const f = fixture("/threads/r1", "PATCH", { archived: true });
    expect(await (await handleThreads(f.ctx))!.json()).toMatchObject({ ok: true, thread: { id: "r1", status: "archived" } });
    expect(f.forward).toHaveBeenLastCalledWith("POST", "/api/runs/r1/archive");
  });
  it.each([{ title: "New title" }, { archived: false }, { expectedArchiveVersion: 0, archived: true }])("explicitly rejects unsupported metadata: %j", async (body) => {
    expect((await handleThreads(fixture("/threads/r1", "PATCH", body).ctx))!.status).toBe(501);
  });
  it("does not turn arbitrary question answers into approval decisions", async () => {
    expect(await (await handleThreads(fixture("/threads/r1/questions").ctx))!.json()).toEqual({ ok: true, questions: [] });
    const f = fixture("/threads/r1/questions/a1", "POST", { answer: "approve" });
    expect((await handleThreads(f.ctx))!.status).toBe(404);
    expect(f.forward).toHaveBeenCalledTimes(1);
    expect((await handleThreads(fixture("/threads/r1/compact", "POST", {}).ctx))!.status).toBe(501);
  });
  it("does not pretend private receipts have a public read endpoint", async () => {
    expect((await handleSystem(fixture("/operations/queue%3Aonce").ctx))!.status).toBe(501);
  });
});
