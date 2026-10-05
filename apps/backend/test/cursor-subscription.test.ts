/**
 * `cursor-subscription` connect lane — the operator's own Cursor Agent API
 * key held as a Worker secret. Unlike T48–T50 this lane carries no run
 * harness, so coverage lives at the route + controller + egress seam:
 *   1. opt-in: absent SHIBA_CURSOR_SUBSCRIPTION the route 404s;
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
import { forwardCursorSubscription, type EgressEnv } from "../src/egress.js";
import { cursorSubscriptionSecretName } from "@shiba/auth";
import { cursorSubscriptionHarness } from "../src/harness/cursor-subscription.js";
import { Sandbox } from "../src/sandbox.js";
import { formatAgentToolInput, parseAgentToolInput, type CodingTaskInput } from "../src/opencode-input.js";
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
    SHIBA_CURSOR_SUBSCRIPTION: "1",
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
  it("404s every verb while SHIBA_CURSOR_SUBSCRIPTION is unset", async () => {
    const env = { AGENT_TOKENS: new FakeKV() } as unknown as Env;
    for (const request of [
      get("/api/auth/cursor-subscription"),
      post("/api/auth/cursor-subscription/begin"),
      post("/api/auth/cursor-subscription/verify"),
      post("/api/auth/cursor-subscription/clear"),
    ]) {
      const response = (await handleSubscriptionAuth(request, env))!;
      expect(response.status).toBe(404);
    }
  });

  it("serves a snapshot once the flag is on; unknown verbs still 404", async () => {
    const response = (await handleSubscriptionAuth(get("/api/auth/cursor-subscription"), envWith()))!;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { snapshot: { phase: string } };
    expect(body.snapshot.phase).toBe("idle");
    const miss = (await handleSubscriptionAuth(
      post("/api/auth/cursor-subscription/nonsense"),
      envWith(),
    ))!;
    expect(miss.status).toBe(404);
  });
});

describe("per-account secret naming", () => {
  it("default → CURSOR_SUBSCRIPTION_TOKEN; named → _<ACCOUNT> uppercased", () => {
    expect(cursorSubscriptionSecretName("default")).toBe("CURSOR_SUBSCRIPTION_TOKEN");
    expect(cursorSubscriptionSecretName("work-acct")).toBe("CURSOR_SUBSCRIPTION_TOKEN_WORK_ACCT");
  });
});

describe("egress branch", () => {
  it("refuses non-cursor hosts and non-GET/POST, 503s on missing secret", async () => {
    const env = { CURSOR_SUBSCRIPTION_TOKEN: "key-real" } as unknown as EgressEnv;
    expect(
      (await forwardCursorSubscription(new Request("https://evil.example.com/x"), env)).status,
    ).toBe(403);
    expect(
      (
        await forwardCursorSubscription(
          new Request("http://api2.cursor.sh/auth/exchange_user_api_key"),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await forwardCursorSubscription(
          new Request("https://api2.cursor.sh/x", { method: "DELETE" }),
          env,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await forwardCursorSubscription(
          new Request("https://api2.cursor.sh/x"),
          {} as unknown as EgressEnv,
        )
      ).status,
    ).toBe(503);
    // The named account resolves its own secret — absent it, fail closed.
    expect(
      (
        await forwardCursorSubscription(
          new Request("https://api2.cursor.sh/x"),
          { CURSOR_SUBSCRIPTION_TOKEN: "key-default" } as unknown as EgressEnv,
          { params: { account: "work" } },
        )
      ).status,
    ).toBe(503);
  });

  it("attaches Bearer to api2.cursor.sh and repo2.cursor.sh on the wire", async () => {
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
      const env = { CURSOR_SUBSCRIPTION_TOKEN_WORK: "key-work" } as unknown as EgressEnv;
      await forwardCursorSubscription(
        new Request("https://api2.cursor.sh/auth/exchange_user_api_key", {
          method: "POST",
          body: "{}",
        }),
        env,
        { params: { account: "work" } },
      );
      expect(seen.auth).toBe("Bearer key-work");
      await forwardCursorSubscription(new Request("https://repo2.cursor.sh/context"), env, {
        params: { account: "work" },
      });
      expect(seen.urls).toEqual([
        "https://api2.cursor.sh/auth/exchange_user_api_key",
        "https://repo2.cursor.sh/context",
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("auth flow", () => {
  it("begin without the secret refuses with provisioning guidance", async () => {
    const response = (await handleSubscriptionAuth(
      post("/api/auth/cursor-subscription/begin"),
      envWith(),
    ))!;
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("CURSOR_SUBSCRIPTION_TOKEN is not set");
    expect(body.error).toContain("wrangler secret put");
  });

  it("verify probes through the forwarder: 200 → succeeded, 401 → failed", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const env = envWith({ CURSOR_SUBSCRIPTION_TOKEN: "key-real" });
      await handleSubscriptionAuth(post("/api/auth/cursor-subscription/begin"), env);
      const verified = (await handleSubscriptionAuth(
        post("/api/auth/cursor-subscription/verify"),
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
      const env = envWith({ CURSOR_SUBSCRIPTION_TOKEN: "key-stale" });
      await handleSubscriptionAuth(post("/api/auth/cursor-subscription/begin"), env);
      const verified = (await handleSubscriptionAuth(
        post("/api/auth/cursor-subscription/verify"),
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
    const env = envWith({ CURSOR_SUBSCRIPTION_TOKEN: "key-real" });
    await handleSubscriptionAuth(post("/api/auth/cursor-subscription/begin"), env);
    for (const verb of ["verify", "clear"]) {
      const response = (await handleSubscriptionAuth(
        post(`/api/auth/cursor-subscription/${verb}`, {}, "intruder@example.com"),
        env,
      ))!;
      expect(response.status).toBe(403);
    }
  });

  it("clear is idempotent and a named account resolves its own secret", async () => {
    const env = envWith({ CURSOR_SUBSCRIPTION_TOKEN_WORK: "key-work" });
    await handleSubscriptionAuth(
      post("/api/auth/cursor-subscription/begin", { account: "work" }),
      env,
    );
    for (let i = 0; i < 2; i++) {
      const cleared = (await handleSubscriptionAuth(
        post("/api/auth/cursor-subscription/clear", { account: "work" }),
        env,
      ))!;
      expect(cleared.status).toBe(200);
      const body = (await cleared.json()) as { snapshot: { phase: string } };
      expect(body.snapshot.phase).toBe("cleared");
    }
  });
});

/**
 * The runnable-harness layer: `SHIBA_CURSOR_SUBSCRIPTION=1` now registers a
 * real sandbox harness — the connect lane exists so a run can authenticate,
 * so these tests pin the run-side contract the same way claude-subscription
 * does.
 */
describe("run harness registration", () => {
  const ENABLED = { SHIBA_CURSOR_SUBSCRIPTION: "1" };
  const SUB_MODEL = "cursor-subscription/claude-4-5-sonnet";
  const runInput = (extra: Partial<CodingTaskInput> = {}): CodingTaskInput => ({
    repoUrl: "https://github.com/acme/widgets",
    task: "Fix it.",
    baseBranch: "main",
    publishPullRequest: false,
    sandboxId: "run-abcdef12345678",
    codingModel: SUB_MODEL,
    ...extra,
  });

  it("is unregistered without the flag — not selectable, not listed", async () => {
    const { resolveHarness, SANDBOX_HARNESS_NAMES, sandboxHarnessNames } = await import(
      "../src/harness/index.js"
    );
    const { agentCliCatalog } = await import("../src/harness/catalog.js");
    expect(() => resolveHarness("cursor-subscription")).toThrow(/Unknown agent harness/);
    expect(() => resolveHarness("cursor-subscription", {})).toThrow(/Unknown agent harness/);
    expect(SANDBOX_HARNESS_NAMES).not.toContain("cursor-subscription");
    expect(agentCliCatalog({}).map((a) => a.id)).not.toContain("cursor-subscription");
    expect(sandboxHarnessNames({})).not.toContain("cursor-subscription");
  });

  it("SHIBA_CURSOR_SUBSCRIPTION=1 registers it everywhere it should appear", async () => {
    const { resolveHarness, sandboxHarnessNames } = await import("../src/harness/index.js");
    const { agentCliCatalog } = await import("../src/harness/catalog.js");
    expect(resolveHarness("cursor-subscription", ENABLED).name).toBe("cursor-subscription");
    expect(sandboxHarnessNames(ENABLED)).toContain("cursor-subscription");
    const entry = agentCliCatalog(ENABLED).find((a) => a.id === "cursor-subscription");
    expect(entry).toBeDefined();
    expect(entry?.credential?.label).toBe("CURSOR_SUBSCRIPTION_TOKEN");
    expect(entry?.credential?.configured).toBe(false);
    const configured = agentCliCatalog({ ...ENABLED, CURSOR_SUBSCRIPTION_TOKEN: "key-real" }).find(
      (a) => a.id === "cursor-subscription",
    );
    expect(configured?.credential?.configured).toBe(true);
  });

  it("the task envelope accepts the harness name and freezes authAccount", () => {
    const input = runInput({ harness: "cursor-subscription", authAccount: "work" });
    const envelope = formatAgentToolInput(input);
    const parsed = parseAgentToolInput([{ role: "user", text: envelope }]);
    expect(parsed.harness).toBe("cursor-subscription");
    expect(parsed.authAccount).toBe("work");
  });
});

describe("the token never enters the container", () => {
  it("env() carries only the dummy CURSOR_API_KEY", () => {
    const env = cursorSubscriptionHarness.env({
      repoUrl: "https://github.com/acme/widgets",
      task: "Fix it.",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "run-1",
      codingModel: "cursor-subscription/claude-4-5-sonnet",
    });
    expect(env.CURSOR_API_KEY).toBe("shiba-dummy-key");
    for (const value of Object.values(env)) {
      expect(value).not.toContain("key-real");
    }
  });

  it("configFile embeds the run config in the ACP driver — auto resolves to null model", () => {
    const file = cursorSubscriptionHarness.configFile(
      {
        repoUrl: "https://github.com/acme/widgets",
        task: "Fix it.",
        baseBranch: "main",
        publishPullRequest: false,
        sandboxId: "run-1",
        codingModel: "cursor-subscription/auto",
      },
      "run-1",
    );
    expect(file.path).toBe("/workspace/run-1.cursor-driver.cjs");
    expect(file.contents).toContain('"model":null');
    expect(file.contents).toContain('"task":"Fix it."');
    expect(file.contents).toContain('"argv":["cursor-agent","--force","acp"]');
    expect(file.contents).not.toContain("key-real");
  });
});

describe("egress isolation", () => {
  it("egressOverrides pins both Cursor hosts to the dedicated handler with the account name", () => {
    const overrides = cursorSubscriptionHarness.egressOverrides!({
      repoUrl: "https://github.com/acme/widgets",
      task: "Fix it.",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "run-1",
      codingModel: "cursor-subscription/claude-4-5-sonnet",
      authAccount: "work",
    });
    expect(overrides.map((o) => o.host).sort()).toEqual(["api2.cursor.sh", "repo2.cursor.sh"].sort());
    for (const o of overrides) {
      expect(o.handler).toBe("cursorSubscription");
      expect(o.params).toEqual({ account: "work" });
      expect(JSON.stringify(o.params)).not.toContain("key-real");
    }
  });

  it("the named handler is registered on Sandbox.outboundHandlers", () => {
    expect(Sandbox.outboundHandlers?.cursorSubscription).toBe(forwardCursorSubscription);
  });

  it("egressHosts is the enumerated pair; a gateway model id is refused", () => {
    expect(cursorSubscriptionHarness.egressHosts("cursor-subscription/claude-4-5-sonnet")).toEqual([
      "api2.cursor.sh",
      "repo2.cursor.sh",
    ]);
    expect(() => cursorSubscriptionHarness.egressHosts("cursor/claude-4-5-sonnet")).toThrow(
      /Unsupported coding model/,
    );
    expect(() => cursorSubscriptionHarness.egressHosts("anthropic/claude-sonnet-4-6")).toThrow(
      /Unsupported coding model/,
    );
  });
});

describe("admission gate (T47 controller)", () => {
  it("declares the auth requirement with the account-scoped instanceId", () => {
    const input = (account?: string): CodingTaskInput => ({
      repoUrl: "https://github.com/acme/widgets",
      task: "Fix it.",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "run-1",
      codingModel: "cursor-subscription/claude-4-5-sonnet",
      authAccount: account,
    });
    expect(cursorSubscriptionHarness.auth?.instanceId(input("work"))).toBe("cursor-sub:work");
    expect(cursorSubscriptionHarness.auth?.instanceId(input())).toBe("cursor-sub:default");
  });

  it("a run without a succeeded flow is refused", async () => {
    const { assertHarnessAuthorized } = await import("../src/auth/index.js");
    await expect(
      assertHarnessAuthorized(envWith({ CURSOR_SUBSCRIPTION_TOKEN: "key-real" }), cursorSubscriptionHarness, {
        repoUrl: "https://github.com/acme/widgets",
        task: "Fix it.",
        baseBranch: "main",
        publishPullRequest: false,
        sandboxId: "run-1",
        codingModel: "cursor-subscription/claude-4-5-sonnet",
      }),
    ).rejects.toThrow(/no authenticated account/);
  });
});
