import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SLACK_EVENTS_PATH,
  clearSeenSlackEvents,
  handleSlackEvents,
} from "../src/slack-events.js";

const SECRET = "test-events-signing-secret";

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

function eventEnv() {
  return { SLACK_SIGNING_SECRET: SECRET } as never;
}

async function signedEventsRequest(body: string, secret = SECRET): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(secret, timestamp, body);
  return new Request(`https://example.com${SLACK_EVENTS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

function stubCtx() {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waited.push(promise);
    }),
  } as unknown as ExecutionContext;
  return { ctx, waited };
}

beforeEach(() => {
  clearSeenSlackEvents();
});

describe("slack events endpoint (T12)", () => {
  it("echoes the url_verification challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123challenge" });
    const request = await signedEventsRequest(body);
    const { ctx } = stubCtx();
    const response = await handleSlackEvents(request, eventEnv(), ctx);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({ challenge: "abc123challenge" });
    // No background work scheduled for the handshake.
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("acks event callbacks with 200 and defers work via waitUntil", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvFAST01",
      event: { type: "app_mention", text: "<@U1> fix this" },
    });
    const request = await signedEventsRequest(body);
    const { ctx, waited } = stubCtx();
    const onEvent = vi.fn(async () => {});
    const response = await handleSlackEvents(request, eventEnv(), ctx, { onEvent });
    expect(response!.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await Promise.all(waited);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("dedupes retries with the same event_id (one run per mention)", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvDUPE01",
      event: { type: "app_mention", text: "<@U1> fix this" },
    });
    const onEvent = vi.fn(async () => {});
    const first = stubCtx();
    const firstResponse = await handleSlackEvents(
      await signedEventsRequest(body),
      eventEnv(),
      first.ctx,
      { onEvent },
    );
    expect(firstResponse!.status).toBe(200);
    expect(first.ctx.waitUntil).toHaveBeenCalledOnce();

    // Slack retry of the same event: acked but never dispatched twice.
    const retry = stubCtx();
    const retryResponse = await handleSlackEvents(
      await signedEventsRequest(body),
      eventEnv(),
      retry.ctx,
      { onEvent },
    );
    expect(retryResponse!.status).toBe(200);
    expect(retry.ctx.waitUntil).not.toHaveBeenCalled();
    await Promise.all(first.waited);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("durable dedupe suppresses retries that land on a fresh isolate", async () => {
    // Simulate a retry on another isolate: clear the in-memory ring, the
    // durable dep still reports the id as seen.
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvDURABLE",
      event: { type: "app_mention", text: "<@U1> fix this" },
    });
    const onEvent = vi.fn(async () => {});
    const first = stubCtx();
    await handleSlackEvents(await signedEventsRequest(body), eventEnv(), first.ctx, {
      onEvent,
      dedupe: async () => false,
    });
    clearSeenSlackEvents();

    const dedupe = vi.fn(async () => true);
    const retry = stubCtx();
    const retryResponse = await handleSlackEvents(
      await signedEventsRequest(body),
      eventEnv(),
      retry.ctx,
      { onEvent, dedupe },
    );
    expect(retryResponse!.status).toBe(200);
    expect(dedupe).toHaveBeenCalledWith("EvDURABLE");
    expect(retry.ctx.waitUntil).not.toHaveBeenCalled();
    await Promise.all(first.waited);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("fails open and dispatches when the dedupe backend errors", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvFAILOPEN",
      event: { type: "app_mention", text: "<@U1> fix this" },
    });
    const onEvent = vi.fn(async () => {});
    const { ctx, waited } = stubCtx();
    const response = await handleSlackEvents(
      await signedEventsRequest(body),
      eventEnv(),
      ctx,
      {
        onEvent,
        dedupe: async () => {
          throw new Error("DO unreachable");
        },
      },
    );
    expect(response!.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await Promise.all(waited);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("rejects a tampered body with 401 and schedules nothing", async () => {
    const signedBody = JSON.stringify({ type: "url_verification", challenge: "x" });
    const request = await signedEventsRequest(signedBody);
    // Tamper after signing: build a new request with the same signature.
    const tampered = new Request(request, {
      body: JSON.stringify({ type: "url_verification", challenge: "tampered" }),
    });
    const { ctx } = stubCtx();
    const response = await handleSlackEvents(tampered, eventEnv(), ctx);
    expect(response?.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects a 6-minute-old timestamp with 401 (replay protection)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const timestamp = String(Math.floor(Date.now() / 1000) - 360);
    const signature = await sign(SECRET, timestamp, body);
    const request = new Request(`https://example.com${SLACK_EVENTS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });
    const { ctx } = stubCtx();
    const response = await handleSlackEvents(request, eventEnv(), ctx);
    expect(response?.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("returns 503 when SLACK_SIGNING_SECRET is not configured", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const request = await signedEventsRequest(body);
    const { ctx } = stubCtx();
    const response = await handleSlackEvents(request, {} as never, ctx);
    expect(response?.status).toBe(503);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("returns null for non-events paths so routing can fall through", async () => {
    const request = new Request("https://example.com/api/runs", { method: "GET" });
    const { ctx } = stubCtx();
    await expect(handleSlackEvents(request, eventEnv(), ctx)).resolves.toBeNull();
  });
});
