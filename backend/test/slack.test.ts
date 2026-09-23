import { describe, expect, it, vi } from "vitest";
import { handleSlackCommand } from "../src/slack-routes.js";
import { verifySlackRequest } from "../src/slack.js";

const SECRET = "test-signing-secret-abc123";

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

function headers(timestamp: string, signature: string): Headers {
  return new Headers({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  });
}

describe("verifySlackRequest", () => {
  it("verifies valid Slack signature", async () => {
    const body = "token=abc&team_id=T123&command=%2Fshiba-ai-coworker&text=fix+this";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(SECRET, timestamp, body);
    await expect(verifySlackRequest(body, headers(timestamp, signature), SECRET)).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = "command=%2Fshiba-ai-coworker&text=fix+this";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(SECRET, timestamp, body);
    await expect(
      verifySlackRequest(`${body}&tampered=true`, headers(timestamp, signature), SECRET),
    ).resolves.toBe(false);
  });

  it("rejects a 6-minute-old timestamp (replay protection)", async () => {
    const body = "command=%2Fshiba-ai-coworker&text=fix+this";
    const timestamp = String(Math.floor(Date.now() / 1000) - 360);
    const signature = await sign(SECRET, timestamp, body);
    await expect(verifySlackRequest(body, headers(timestamp, signature), SECRET)).resolves.toBe(false);
  });

  it("rejects missing headers and missing secret", async () => {
    const body = "command=%2Fshiba-ai-coworker&text=fix+this";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(SECRET, timestamp, body);
    await expect(verifySlackRequest(body, new Headers(), SECRET)).resolves.toBe(false);
    await expect(verifySlackRequest(body, headers(timestamp, signature), "")).resolves.toBe(false);
  });
});

describe("slack slash command", () => {
  const ROUTE_SECRET = "test-route-signing-secret";

  async function signedCommandRequest(
    params: Record<string, string>,
    secret = ROUTE_SECRET,
  ): Promise<Request> {
    const body = new URLSearchParams(params).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(secret, timestamp, body);
    return new Request("https://example.com/api/slack/command", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...Object.fromEntries(headers(timestamp, signature)),
      },
      body,
    });
  }

  function routeEnv() {
    return { SLACK_SIGNING_SECRET: ROUTE_SECRET, CodingOrchestrator: {} } as never;
  }

  it("routes slash command to orchestrator and returns Task queued", async () => {
    const request = await signedCommandRequest({
      command: "/shiba-ai-coworker",
      text: "https://github.com/owner/repo Fix the login bug",
      user_id: "U123",
      channel_id: "C456",
    });
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true, approvalId: "a-77" }), { status: 200 }),
    );
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
    });
    expect(response).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const forwarded = fetchMock.mock.calls[0]?.[0] as unknown as Request;
    const payload = (await forwarded.json()) as { repoUrl: string; task: string };
    expect(payload.repoUrl).toBe("https://github.com/owner/repo");
    expect(payload.task).toContain("Fix the login bug");
    expect(response!.status).toBe(200);
    // The queued reply carries the approval card so a human can act on it.
    const body = (await response!.json()) as { text?: string; blocks?: { type: string; elements?: unknown[] }[] };
    expect(body.text).toContain("Task queued");
    const actions = body.blocks?.find((b) => b.type === "actions");
    expect(JSON.stringify(actions)).toContain("a-77");
  });

  it("rejects an invalid Slack signature with 401 and queues nothing", async () => {
    const request = await signedCommandRequest(
      { command: "/shiba-ai-coworker", text: "https://github.com/owner/repo Fix it" },
      "wrong-secret",
    );
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
    });
    expect(response?.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 when no GitHub URL is present", async () => {
    const request = await signedCommandRequest({
      command: "/shiba-ai-coworker",
      text: "fix it please",
    });
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
    });
    expect(response?.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores non-slash-command paths", async () => {
    const request = new Request("https://example.com/api/runs", { method: "GET" });
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: vi.fn() },
    });
    expect(response).toBeNull();
  });
});
