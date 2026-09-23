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

  it("returns 200 with an ephemeral usage message when no GitHub URL is present", async () => {
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
    // A 400 renders Slack's generic "failed"; a 200 ephemeral carries the hint.
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { response_type?: string; text?: string };
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("Usage:");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acks fast and delivers the card via response_url when ctx is provided", async () => {
    const responseUrl = "https://hooks.slack.com/commands/T1/123/token";
    const request = await signedCommandRequest({
      command: "/shiba-ai-coworker",
      text: "https://github.com/owner/repo Fix the login bug",
      user_id: "U123",
      channel_id: "C456",
      response_url: responseUrl,
    });
    let releaseQueue!: (r: Response) => void;
    const fetchMock = vi.fn(
      async (_req: Request) =>
        new Promise<Response>((resolve) => {
          releaseQueue = resolve;
        }),
    );
    const respond = vi.fn(async (_url: string, _body: Record<string, unknown>): Promise<void> => {});
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
      respond,
    }, ctx);
    // The ack goes out before the orchestrator answers — under the 3s window.
    expect(response?.status).toBe(200);
    const ack = (await response!.json()) as { response_type?: string; text?: string };
    expect(ack.response_type).toBe("ephemeral");
    expect(respond).not.toHaveBeenCalled();
    releaseQueue(new Response(JSON.stringify({ ok: true, approvalId: "a-88" }), { status: 200 }));
    await Promise.all(pending);
    expect(respond).toHaveBeenCalledOnce();
    const [url, card] = respond.mock.calls[0] as [string, { text?: string; blocks?: unknown[] }];
    expect(url).toBe(responseUrl);
    expect(card.text).toContain("Task queued");
    expect(JSON.stringify(card.blocks)).toContain("a-88");
  });

  it("queues with mention-lane parity: publishPullRequest on, channel/user carried", async () => {
    const request = await signedCommandRequest({
      command: "/shiba-ai-coworker",
      text: "https://github.com/owner/repo Fix it",
      user_id: "U123",
      channel_id: "C456",
    });
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true, approvalId: "a-1" }), { status: 200 }),
    );
    await handleSlackCommand(request, routeEnv(), { orchestratorStub: { fetch: fetchMock } });
    const forwarded = fetchMock.mock.calls[0]?.[0] as unknown as Request;
    const payload = (await forwarded.json()) as Record<string, unknown>;
    expect(payload.publishPullRequest).toBe(true);
    expect(payload.source).toBe("slack");
    expect(payload.channel_id).toBe("C456");
    expect(payload.user_id).toBe("U123");
  });

  it("reports a queue failure via response_url instead of a 502", async () => {
    const responseUrl = "https://hooks.slack.com/commands/T1/123/token";
    const request = await signedCommandRequest({
      command: "/shiba-ai-coworker",
      text: "https://github.com/owner/repo Fix it",
      response_url: responseUrl,
    });
    const fetchMock = vi.fn(async (_req: Request) =>
      Response.json({ error: "publishPullRequest was requested but GITHUB_TOKEN is not configured." }, { status: 400 }),
    );
    const respond = vi.fn(async (_url: string, _body: Record<string, unknown>): Promise<void> => {});
    const pending: Promise<unknown>[] = [];
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
      respond,
    }, { waitUntil: (p) => pending.push(p) });
    expect(response?.status).toBe(200);
    await Promise.all(pending);
    expect(respond).toHaveBeenCalledOnce();
    const [, card] = respond.mock.calls[0] as [string, { text?: string }];
    expect(card.text).toMatch(/failed to queue/i);
    // The orchestrator's reason reaches the user — retrying won't fix a config error.
    expect(card.text).toContain("GITHUB_TOKEN");
  });

  it("without ctx, awaits the queue and returns the card inline even with a response_url", async () => {
    const request = await signedCommandRequest({
      command: "/shiba-ai-coworker",
      text: "https://github.com/owner/repo Fix it",
      response_url: "https://hooks.slack.com/commands/T1/123/token",
    });
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ ok: true, approvalId: "a-2" }), { status: 200 }),
    );
    const respond = vi.fn(async (_url: string, _body: Record<string, unknown>): Promise<void> => {});
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: fetchMock },
      respond,
    });
    const body = (await response!.json()) as { text?: string; blocks?: unknown[] };
    expect(body.text).toContain("Task queued");
    expect(JSON.stringify(body.blocks)).toContain("a-2");
    expect(respond).not.toHaveBeenCalled();
  });

  it("ignores non-slash-command paths", async () => {
    const request = new Request("https://example.com/api/runs", { method: "GET" });
    const response = await handleSlackCommand(request, routeEnv(), {
      orchestratorStub: { fetch: vi.fn() },
    });
    expect(response).toBeNull();
  });
});
