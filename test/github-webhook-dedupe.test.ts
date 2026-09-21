import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => new Response("{}", { status: 404 }) }),
  routeAgentRequest: async () => null,
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const SECRET = "whsec-test";

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `sha256=${Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface Harness {
  env: Env;
  ctx: ExecutionContext;
  stubFetch: ReturnType<typeof vi.fn>;
  fanOutUrls: () => string[];
  dedupeUrls: () => string[];
}

function makeHarness(opts: { dedupeError?: boolean } = {}): Harness {
  const seenKeys = new Set<string>();
  const stubFetch = vi.fn(async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/internal/dedupe") {
      if (opts.dedupeError) throw new Error("dedupe DO unreachable");
      const { key } = (await request.json()) as { key: string };
      const seen = seenKeys.has(key);
      seenKeys.add(key);
      return Response.json({ seen });
    }
    return new Response("{}", { status: 200 });
  });
  const urlsFor = (path: string) =>
    stubFetch.mock.calls
      .map((call) => new URL((call[0] as Request).url).pathname)
      .filter((p) => p === path);
  const env = {
    GITHUB_WEBHOOK_SECRET: SECRET,
    Sandbox: {},
    Automations: {
      idFromName: () => "automations",
      get: () => ({ fetch: stubFetch }),
    },
  } as unknown as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;
  return {
    env,
    ctx,
    stubFetch,
    fanOutUrls: () => urlsFor("/internal/github"),
    dedupeUrls: () => urlsFor("/internal/dedupe"),
  };
}

function webhookRequest(harness: Harness, opts: { deliveryId?: string; signature?: string | null; payload?: string } = {}) {
  const payload = opts.payload ?? JSON.stringify({ action: "opened", number: 1 });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": "issues",
  };
  if (opts.deliveryId) headers["x-github-delivery"] = opts.deliveryId;
  return sign(payload).then((signature) => {
    const sig = opts.signature === undefined ? signature : opts.signature;
    if (sig) headers["x-hub-signature-256"] = sig;
    return worker.fetch(
      new Request("https://worker/api/github/webhook", { method: "POST", headers, body: payload }),
      harness.env,
      harness.ctx,
    );
  });
}

describe("github webhook delivery dedupe", () => {
  it("dedupes a repeated x-github-delivery and fans out once", async () => {
    const h = makeHarness();
    const first = await webhookRequest(h, { deliveryId: "d-1" });
    expect(first.status).toBe(200);
    const second = await webhookRequest(h, { deliveryId: "d-1" });
    expect(await second.json()).toEqual({ ok: true, deduped: true });
    expect(h.fanOutUrls()).toHaveLength(1);
    expect(h.dedupeUrls()).toHaveLength(2);
  });

  it("fans out when x-github-delivery is missing (backward compatible)", async () => {
    const h = makeHarness();
    const response = await webhookRequest(h);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, event: "issues", action: "opened" });
    expect(h.fanOutUrls()).toHaveLength(1);
    expect(h.dedupeUrls()).toHaveLength(0);
  });

  it("fans out when the dedupe endpoint errors (fail-open)", async () => {
    const h = makeHarness({ dedupeError: true });
    const response = await webhookRequest(h, { deliveryId: "d-err" });
    expect(response.status).toBe(200);
    expect(h.fanOutUrls()).toHaveLength(1);
    expect(h.dedupeUrls()).toHaveLength(1);
  });

  it("rejects a bad signature before any dedupe write", async () => {
    const h = makeHarness();
    const response = await webhookRequest(h, { deliveryId: "d-bad", signature: "sha256=deadbeef" });
    expect(response.status).toBe(401);
    expect(h.stubFetch).not.toHaveBeenCalled();
  });

  it("rejects a missing signature before any dedupe write", async () => {
    const h = makeHarness();
    const response = await webhookRequest(h, { deliveryId: "d-none", signature: null });
    expect(response.status).toBe(401);
    expect(h.stubFetch).not.toHaveBeenCalled();
  });
});
