import { describe, expect, it } from "vitest";
import { TRIGGER_PATH, handleTrigger } from "../src/trigger.js";

const TOKEN = "test-trigger-token";

function triggerEnv(token?: string) {
  return (token === undefined ? {} : { TRIGGER_TOKEN: token }) as never;
}

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function makeStub(response: Response, calls: RecordedCall[] = []) {
  return {
    calls,
    fetch: async (request: Request) => {
      calls.push({
        url: request.url,
        method: request.method,
        body: (await request.json()) as Record<string, unknown>,
      });
      return response;
    },
  };
}

function triggerRequest(body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request(`https://worker.example${TRIGGER_PATH}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/trigger", () => {
  it("returns null for other paths and methods so routing falls through", async () => {
    expect(await handleTrigger(new Request("https://worker.example/api/other", { method: "POST" }), triggerEnv())).toBeNull();
    expect(
      await handleTrigger(new Request(`https://worker.example${TRIGGER_PATH}`, { method: "GET" }), triggerEnv()),
    ).toBeNull();
  });

  it("answers 503 while TRIGGER_TOKEN is unset or empty", async () => {
    const unset = await handleTrigger(triggerRequest({ repoUrl: "https://github.com/a/b", task: "x" }), triggerEnv());
    expect(unset!.status).toBe(503);
    const empty = await handleTrigger(
      triggerRequest({ repoUrl: "https://github.com/a/b", task: "x" }),
      triggerEnv(""),
    );
    expect(empty!.status).toBe(503);
  });

  it("answers 401 on a missing or wrong bearer token", async () => {
    const missing = await handleTrigger(
      triggerRequest({ repoUrl: "https://github.com/a/b", task: "x" }, null),
      triggerEnv(TOKEN),
    );
    expect(missing!.status).toBe(401);
    const wrong = await handleTrigger(
      triggerRequest({ repoUrl: "https://github.com/a/b", task: "x" }, "wrong-token"),
      triggerEnv(TOKEN),
    );
    expect(wrong!.status).toBe(401);
  });

  it("answers 400 on invalid JSON, a bad repo URL, or a missing task", async () => {
    const env = triggerEnv(TOKEN);
    const stub = makeStub(Response.json({ ok: true, approvalId: "apv-1" }));
    for (const body of [
      "not-json{",
      "42",
      { repoUrl: "https://example.com/not-github", task: "fix it" },
      { repoUrl: "https://github.com/a/b" },
      { repoUrl: "https://github.com/a/b", task: "   " },
    ]) {
      const response = await handleTrigger(triggerRequest(body), env, { orchestratorStub: stub });
      expect(response!.status).toBe(400);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("queues the run on the shared orchestrator and reports pending_approval", async () => {
    const calls: RecordedCall[] = [];
    const stub = makeStub(Response.json({ ok: true, approvalId: "apv-123" }), calls);
    const response = await handleTrigger(
      triggerRequest({ repoUrl: "https://github.com/princepal9120/shiba", task: "add a health check" }),
      triggerEnv(TOKEN),
      { orchestratorStub: stub },
    );
    expect(response!.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://internal/api/runs");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      repoUrl: "https://github.com/princepal9120/shiba",
      task: "add a health check",
      baseBranch: "main",
      publishPullRequest: false,
      source: "trigger",
    });
    await expect(response!.json()).resolves.toEqual({
      status: "pending_approval",
      approvalId: "apv-123",
      approveUrl: "https://worker.example/app/",
      message: "queued — approve it on the dashboard",
    });
  });

  it("forwards baseBranch and publishPullRequest overrides to the orchestrator", async () => {
    const calls: RecordedCall[] = [];
    const stub = makeStub(Response.json({ ok: true, approvalId: "apv-9" }), calls);
    const response = await handleTrigger(
      triggerRequest({
        repoUrl: "https://github.com/a/b",
        task: "release prep",
        baseBranch: "release/1.0",
        publishPullRequest: true,
      }),
      triggerEnv(TOKEN),
      { orchestratorStub: stub },
    );
    expect(response!.status).toBe(200);
    expect(calls[0]!.body).toMatchObject({
      baseBranch: "release/1.0",
      publishPullRequest: true,
      source: "trigger",
    });
  });

  it("answers 502 when the orchestrator rejects or errors", async () => {
    const rejecting = makeStub(Response.json({ error: "queue full" }, { status: 409 }));
    const rejected = await handleTrigger(
      triggerRequest({ repoUrl: "https://github.com/a/b", task: "x" }),
      triggerEnv(TOKEN),
      { orchestratorStub: rejecting },
    );
    expect(rejected!.status).toBe(502);
    expect(((await rejected!.json()) as { error: string }).error).toContain("queue full");

    const throwing = { fetch: async () => Promise.reject(new Error("stub down")) };
    const errored = await handleTrigger(
      triggerRequest({ repoUrl: "https://github.com/a/b", task: "x" }),
      triggerEnv(TOKEN),
      { orchestratorStub: throwing },
    );
    expect(errored!.status).toBe(502);
  });
});
