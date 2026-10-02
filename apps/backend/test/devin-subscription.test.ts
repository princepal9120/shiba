/**
 * `devin-subscription` connect lane — the operator's own Devin API
 * key/session token held as a Worker secret. Unlike T48–T50 this lane
 * carries no run harness, so coverage lives at the route + controller +
 * egress seam:
 *   1. opt-in: absent SHIBA_DEVIN_SUBSCRIPTION the route 404s;
 *   2. begin() asserts the named Worker secret — never minted here;
 *   3. verify()'s probe rides the same egress forwarder runs use:
 *      200 → succeeded, 401 → failed with the rejection reason;
 *   4. ownership: only the begin owner may verify/clear; clear is
 *      idempotent.
 */
import { describe, expect, it, vi } from "vitest";

// auth-routes pulls the antigravity handler, which imports the Sandbox SDK —
// stub the package surface the same way the other lane tests do.
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  Container: class {},
  proxyToSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getContainer: vi.fn(),
}));

import { handleSubscriptionAuth } from "../src/auth-routes.js";
import { forwardDevinSubscription, type EgressEnv } from "../src/egress.js";
import { devinSubscriptionSecretName } from "@shiba/auth";
import type { Env } from "../src/env.js";

class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

const envWith = (extra: Record<string, unknown> = {}) =>
  ({
    AGENT_TOKENS: new FakeKV(),
    SHIBA_DEVIN_SUBSCRIPTION: "1",
    ...extra,
  }) as unknown as Env;

const post = (path: string, body: unknown = {}, email = "owner@example.com") =>
  new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Access-Authenticated-User-Email": email,
    },
    body: JSON.stringify(body),
  });

const get = (path: string) =>
  new Request(`https://app.example.com${path}`, {
    headers: { "CF-Access-Authenticated-User-Email": "owner@example.com" },
  });

describe("opt-in gate", () => {
  it("404s every verb while SHIBA_DEVIN_SUBSCRIPTION is unset", async () => {
    const env = { AGENT_TOKENS: new FakeKV() } as unknown as Env;
    for (const request of [
      get("/api/auth/devin-subscription"),
      post("/api/auth/devin-subscription/begin"),
      post("/api/auth/devin-subscription/verify"),
      post("/api/auth/devin-subscription/clear"),
    ]) {
      const response = (await handleSubscriptionAuth(request, env))!;
      expect(response.status).toBe(404);
    }
  });

  it("serves a snapshot once the flag is on; unknown verbs still 404", async () => {
    const response = (await handleSubscriptionAuth(get("/api/auth/devin-subscription"), envWith()))!;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { snapshot: { phase: string } };
    expect(body.snapshot.phase).toBe("idle");
    const miss = (await handleSubscriptionAuth(
      post("/api/auth/devin-subscription/nonsense"),
      envWith(),
    ))!;
    expect(miss.status).toBe(404);
  });
});

describe("per-account secret naming", () => {
  it("default → DEVIN_SUBSCRIPTION_TOKEN; named → _<ACCOUNT> uppercased", () => {
    expect(devinSubscriptionSecretName("default")).toBe("DEVIN_SUBSCRIPTION_TOKEN");
    expect(devinSubscriptionSecretName("work-acct")).toBe("DEVIN_SUBSCRIPTION_TOKEN_WORK_ACCT");
  });
});

describe("egress branch", () => {
  it("refuses non-devin hosts and non-GET/POST, 503s on missing secret", async () => {
    const env = { DEVIN_SUBSCRIPTION_TOKEN: "key-real" } as unknown as EgressEnv;
    expect(
      (await forwardDevinSubscription(new Request("https://evil.example.com/x"), env)).status,
    ).toBe(403);
    expect(
      (
        await forwardDevinSubscription(
          new Request("https://api.devin.ai/v3/self", { method: "DELETE" }),
          env,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await forwardDevinSubscription(
          new Request("https://api.devin.ai/v3/self"),
          {} as unknown as EgressEnv,
        )
      ).status,
    ).toBe(503);
  });

  it("mirrors forwardDevin's per-host auth: Bearer on api.devin.ai, doubled Basic on codeium", async () => {
    const seen: { auth?: string | null; urls: string[] } = { urls: [] };
    const original = globalThis.fetch;
    globalThis.fetch = (async (req: RequestInfo | URL, init?: RequestInit) => {
      seen.urls.push(req instanceof Request ? req.url : String(req));
      const headers =
        init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as HeadersInit);
      seen.auth = headers.get("authorization");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const env = { DEVIN_SUBSCRIPTION_TOKEN_WORK: "key-work" } as unknown as EgressEnv;
      await forwardDevinSubscription(new Request("https://api.devin.ai/v3/self"), env, {
        params: { account: "work" },
      });
      expect(seen.auth).toBe("Bearer key-work");
      await forwardDevinSubscription(new Request("https://server.codeium.com/exa.rpc", { method: "POST", body: "{}" }), env, {
        params: { account: "work" },
      });
      expect(seen.auth).toBe("Basic key-work-key-work");
      expect(seen.urls).toEqual([
        "https://api.devin.ai/v3/self",
        "https://server.codeium.com/exa.rpc",
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("auth flow", () => {
  it("begin without the secret refuses with provisioning guidance", async () => {
    const response = (await handleSubscriptionAuth(
      post("/api/auth/devin-subscription/begin"),
      envWith(),
    ))!;
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("DEVIN_SUBSCRIPTION_TOKEN is not set");
    expect(body.error).toContain("wrangler secret put");
  });

  it("verify probes through the forwarder: 200 → succeeded, 401 → failed", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const env = envWith({ DEVIN_SUBSCRIPTION_TOKEN: "key-real" });
      await handleSubscriptionAuth(post("/api/auth/devin-subscription/begin"), env);
      const verified = (await handleSubscriptionAuth(
        post("/api/auth/devin-subscription/verify"),
        env,
      ))!;
      const body = (await verified.json()) as { snapshot: { phase: string; message?: string } };
      expect(body.snapshot.phase).toBe("succeeded");
    } finally {
      globalThis.fetch = original;
    }

    const original2 = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    try {
      const env = envWith({ DEVIN_SUBSCRIPTION_TOKEN: "key-stale" });
      await handleSubscriptionAuth(post("/api/auth/devin-subscription/begin"), env);
      const verified = (await handleSubscriptionAuth(
        post("/api/auth/devin-subscription/verify"),
        env,
      ))!;
      const body = (await verified.json()) as { snapshot: { phase: string; message?: string } };
      expect(body.snapshot.phase).toBe("failed");
      expect(body.snapshot.message).toContain("credential rejected (401)");
    } finally {
      globalThis.fetch = original2;
    }
  });

  it("only the begin owner may verify or clear — other sessions get 403", async () => {
    const env = envWith({ DEVIN_SUBSCRIPTION_TOKEN: "key-real" });
    await handleSubscriptionAuth(post("/api/auth/devin-subscription/begin"), env);
    for (const verb of ["verify", "clear"]) {
      const response = (await handleSubscriptionAuth(
        post(`/api/auth/devin-subscription/${verb}`, {}, "intruder@example.com"),
        env,
      ))!;
      expect(response.status).toBe(403);
    }
  });

  it("clear is idempotent and a named account resolves its own secret", async () => {
    const env = envWith({ DEVIN_SUBSCRIPTION_TOKEN_WORK: "key-work" });
    await handleSubscriptionAuth(
      post("/api/auth/devin-subscription/begin", { account: "work" }),
      env,
    );
    for (let i = 0; i < 2; i++) {
      const cleared = (await handleSubscriptionAuth(
        post("/api/auth/devin-subscription/clear", { account: "work" }),
        env,
      ))!;
      expect(cleared.status).toBe(200);
      const body = (await cleared.json()) as { snapshot: { phase: string } };
      expect(body.snapshot.phase).toBe("cleared");
    }
  });
});
