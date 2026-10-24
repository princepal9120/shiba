import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));

import type { AcpProvidersSnapshot } from "@shiba/shared";
import { handleAcpProviders } from "../src/acp-provider-routes.js";
import { ACP_PROVIDER_REGISTRY, acpAdapterPlan } from "../src/acp-providers.js";
import { handleSubscriptionAuth } from "../src/auth-routes.js";
import type { Env } from "../src/env.js";
import { ACP_LANES } from "../src/harness/index.js";

vi.mock("../../frontend/src/live-status", () => ({
  useModelConfig: () => ({
    state: {
      kind: "data",
      data: { connections: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] },
    },
    reload: () => {},
    inFlight: false,
  }),
}));

import { ProvidersBoard } from "../../frontend/src/components/ProvidersView";

class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

function env(extra: Record<string, unknown> = {}, kv: FakeKV = new FakeKV()): Env {
  return { AGENT_TOKENS: kv, ...extra } as unknown as Env;
}

function request(path: string, init?: RequestInit, email?: string): Request {
  const headers = new Headers(init?.headers);
  if (email !== undefined) headers.set("CF-Access-Authenticated-User-Email", email);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function snapshot(response: Response | null): Promise<AcpProvidersSnapshot> {
  if (response === null) throw new Error("expected a provider response");
  expect(response.status).toBe(200);
  return (await response.json()) as AcpProvidersSnapshot;
}

const confirmOk = async () => ({ ok: true, message: "mocked device grant" });
const beginWaiting = async () => ({
  ok: true,
  pending: true,
  message: "paste the callback",
  signInKind: "chatgpt-pkce" as const,
  verificationUri: "https://auth.openai.com/oauth/authorize?x=1",
});

describe("provider registry", () => {
  it("lists an ACP adapter for each dashboard provider, and refuses to call Grok an ACP server", () => {
    expect(ACP_PROVIDER_REGISTRY.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "grok",
      "cursor",
    ]);
    for (const provider of ACP_PROVIDER_REGISTRY) {
      if (provider.protocol === "acp") {
        if (provider.harness === "antigravity-subscription" || provider.harness === "cursor-subscription") {
          expect(provider.spawn.length).toBeGreaterThan(0);
        } else {
          const lane = ACP_LANES[provider.harness as keyof typeof ACP_LANES];
          expect(lane, provider.id).toBeDefined();
          expect(provider.spawn).toEqual(lane.spec.spawn);
        }
        expect(acpAdapterPlan(provider.id).harness).toBe(provider.harness);
      }
    }
    expect(ACP_PROVIDER_REGISTRY.find((provider) => provider.id === "grok")?.protocol).toBe("cli");
    expect(() => acpAdapterPlan("grok")).toThrow(/does not speak ACP/);
  });
});

describe("GET /api/providers", () => {
  it("returns the registry when subscription flags are off", async () => {
    const response = await handleAcpProviders(request("/api/providers"), env());
    const body = await snapshot(response);
    expect(body.org).toBe("default");
    expect(body.defaultProviderId).toBeNull();
    expect(body.providers.map((provider) => provider.connection.phase)).toEqual([
      "disconnected",
      "disconnected",
      "disconnected",
      "disconnected",
      "disconnected",
    ]);
    expect(body.providers.find((provider) => provider.id === "claude")?.capabilities).toMatchObject(
      {
        acp: true,
        oauth: true,
        apiKey: true,
        permissions: true,
        setModel: true,
      },
    );
    expect(JSON.stringify(body)).not.toMatch(/sk-|secret-value|setup-token/);
  });

  it("still lists providers when the connection store is missing", async () => {
    const response = await handleAcpProviders(request("/api/providers"), {} as Env);
    const body = await snapshot(response);
    expect(body.providers).toHaveLength(5);
  });
});

describe("legacy dashboard connector is gone; harness admission stays", () => {
  it("refuses a claude-subscription run that never reached succeeded", async () => {
    const { assertHarnessAuthorized } = await import("../src/auth/index.js");
    const { claudeSubscriptionHarness } = await import("../src/harness/claude-subscription.js");
    await expect(
      assertHarnessAuthorized(env(), claudeSubscriptionHarness, {
        authAccount: "default",
      } as never),
    ).rejects.toThrow(/no authenticated account/);
  });
});

describe("root cause: subscription routes 404 without the flag", () => {
  it("claude-subscription connect is dark, while /api/providers connect is not", async () => {
    const dark = await handleSubscriptionAuth(
      request("/api/auth/claude-subscription", {
        method: "POST",
        body: JSON.stringify({ account: "default" }),
      }),
      env(),
    );
    expect(dark?.status).toBe(404);

    const started = await handleAcpProviders(
      request("/api/providers/claude/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "oauth" }),
      }),
      env(),
    );
    const body = await snapshot(started);
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("waiting");
    expect(claude?.connection.signInKind).toBe("claude-setup-token");
    expect(claude?.connection.userCode).toBeNull();
    expect(claude?.connection.verificationUri).toBeNull();
    expect(claude?.connection.operatorSteps?.join("\n")).toMatch(/claude setup-token/);
    expect(JSON.stringify(body)).not.toMatch(/SHIBA_CLAUDE_SUBSCRIPTION|CLAUDE_SUBSCRIPTION_TOKEN/);
    expect(JSON.stringify(body)).not.toContain("https://claude.ai/login");
  });
});

describe("sign-in is not a local confirmation code", () => {
  const kv = new FakeKV();
  let now = 1_700_000_000_000;
  const deps = {
    now: () => now,
    beginOauth: vi.fn(beginWaiting),
    completeOauth: vi.fn(confirmOk),
  };

  beforeEach(() => {
    kv.map.clear();
    now = 1_700_000_000_000;
    deps.beginOauth.mockClear();
    deps.completeOauth.mockClear();
    deps.beginOauth.mockImplementation(beginWaiting);
    deps.completeOauth.mockImplementation(confirmOk);
  });

  it("starts a real authorize URL and finishes when the callback is accepted", async () => {
    const deployment = env({}, kv);
    const started = await snapshot(
      await handleAcpProviders(
        request("/api/providers/codex/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        deps,
      ),
    );
    const waiting = started.providers.find((provider) => provider.id === "codex");
    expect(waiting?.connection.phase).toBe("waiting");
    expect(waiting?.connection.userCode).toBeNull();
    expect(waiting?.connection.verificationUri).toBe("https://auth.openai.com/oauth/authorize?x=1");
    expect(waiting?.connection.verificationUri).not.toBe("https://chatgpt.com/");

    const callback = "http://127.0.0.1:1455/auth/callback?code=abc&state=xyz";
    const done = await snapshot(
      await handleAcpProviders(
        request("/api/providers/codex/verify", {
          method: "POST",
          body: JSON.stringify({ callbackUrl: callback }),
        }),
        deployment,
        deps,
      ),
    );
    const codex = done.providers.find((provider) => provider.id === "codex");
    expect(codex?.connection.phase).toBe("connected");
    expect(codex?.connection.authMode).toBe("oauth");
    expect(codex?.connection.message).toBe("mocked device grant");
    expect(deps.completeOauth).toHaveBeenCalledOnce();
    expect([...kv.map.values()].join("\n")).not.toContain(callback);
  });

  it("fails an expired sign-in without calling complete", async () => {
    const deployment = env({}, kv);
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        deps,
      ),
    );
    now += 16 * 60 * 1000;
    const expired = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/verify", {
          method: "POST",
          body: JSON.stringify({}),
        }),
        deployment,
        deps,
      ),
    );
    expect(expired.providers.find((provider) => provider.id === "claude")?.connection.phase).toBe(
      "failed",
    );
    expect(deps.completeOauth).not.toHaveBeenCalled();
  });

  it("refuses pasted key material and does not store it", async () => {
    const deployment = env({}, kv);
    const response = await handleAcpProviders(
      request("/api/providers/claude/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "api-key", apiKey: "sk-live-should-not-land" }),
      }),
      deployment,
      deps,
    );
    expect(response?.status).toBe(400);
    expect([...kv.map.values()].join("\n")).not.toContain("sk-live-should-not-land");
  });

  it("rejects a camelCase refresh token instead of connecting", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/claude/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "api-key", refreshToken: "pasted-refresh" }),
      }),
      env({ AI_GATEWAY_TOKEN: "gateway-canary" }),
    );
    expect(response?.status).toBe(400);
  });
});

describe("API-key fallback", () => {
  it("connects when the gateway credential the ACP harness uses is present and never echoes the value", async () => {
    const deployment = env({ AI_GATEWAY_TOKEN: "gateway-canary-value" });
    const body = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "api-key" }),
        }),
        deployment,
      ),
    );
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("connected");
    expect(claude?.connection.authMode).toBe("api-key");
    expect(claude?.connection.message).toContain("AI_GATEWAY_TOKEN");
    expect(claude?.connection.message).toContain("claude-acp");
    expect(JSON.stringify(body)).not.toContain("gateway-canary-value");

    const tested = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/test", { method: "POST", body: "{}" }),
        deployment,
      ),
    );
    expect(tested.providers.find((provider) => provider.id === "claude")?.connection.testOk).toBe(
      true,
    );
  });

  it("does not treat the subscription token as the ACP adapter credential", async () => {
    const body = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "api-key" }),
        }),
        env({ CLAUDE_SUBSCRIPTION_TOKEN: "setup-token-canary-value" }),
      ),
    );
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("disconnected");
    expect(claude?.connection.message ?? "").not.toContain("AI_GATEWAY_TOKEN");
    expect(JSON.stringify(body)).not.toContain("setup-token-canary-value");
  });

  it("stays not connected when no key is pasted and no gateway token is set", async () => {
    const body = await snapshot(
      await handleAcpProviders(
        request("/api/providers/gemini/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "api-key" }),
        }),
        env(),
      ),
    );
    const gemini = body.providers.find((provider) => provider.id === "gemini");
    expect(gemini?.connection.phase).toBe("disconnected");
    expect(gemini?.connection.message ?? "").not.toContain("AI_GATEWAY_TOKEN");
  });

  it("stores a pasted provider key encrypted and does not echo it", async () => {
    const kv = new FakeKV();
    const secret = "AIza-test-key-value";
    const deployment = env({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) }, kv);
    const body = await snapshot(
      await handleAcpProviders(
        request("/api/providers/gemini/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "api-key", credential: secret }),
        }),
        deployment,
      ),
    );
    const gemini = body.providers.find((provider) => provider.id === "gemini");
    expect(gemini?.connection.phase).toBe("connected");
    expect(gemini?.connection.message).toMatch(/stored/i);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect([...kv.map.values()].join("\n")).not.toContain(secret);
  });

  it("renders a stale gateway failure as not connected", async () => {
    const kv = new FakeKV();
    await kv.put(
      "acp_provider:default:grok",
      JSON.stringify({
        phase: "failed",
        authMode: "api-key",
        message: "No credential is provisioned. Set AI_GATEWAY_TOKEN.",
        updatedAt: 1,
      }),
    );
    const body = await snapshot(await handleAcpProviders(request("/api/providers"), env({}, kv)));
    expect(body.providers.find((provider) => provider.id === "grok")?.connection.phase).toBe(
      "disconnected",
    );
  });

  it("refuses unknown provider ids", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/opencode/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "oauth" }),
      }),
      env(),
    );
    expect(response?.status).toBe(404);
  });
});

describe("subscription probe reuse", () => {
  it("redeems Claude setup-token through the subscription controller when the lane is on", async () => {
    const kv = new FakeKV();
    const deployment = env(
      { SHIBA_CLAUDE_SUBSCRIPTION: "1", CLAUDE_SUBSCRIPTION_TOKEN: "setup-token-canary-value" },
      kv,
    );
    const done = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "setup-token" }),
        }),
        deployment,
        { forwardClaude: async () => new Response("{}", { status: 200 }) },
      ),
    );
    const claude = done.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("connected");
    expect(claude?.connection.userCode).toBeNull();
    expect(claude?.connection.message).toContain("setup-token reached the API");
    expect(JSON.stringify(done)).not.toContain("setup-token-canary-value");
    expect([...kv.map.values()].join("\n")).not.toContain("setup-token-canary-value");
  });

  it("records a rejected Claude probe as a failed connection", async () => {
    const deployment = env({
      SHIBA_CLAUDE_SUBSCRIPTION: "1",
      CLAUDE_SUBSCRIPTION_TOKEN: "setup-token-canary-value",
    });
    const done = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "setup-token" }),
        }),
        deployment,
        { forwardClaude: async () => new Response("no", { status: 401 }) },
      ),
    );
    const claude = done.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("failed");
    expect(claude?.connection.message).toContain("credential rejected (401)");
  });

  it("does not restart a succeeded subscription lane from Finish or Test", async () => {
    const kv = new FakeKV();
    const flowKey = "auth_flow_claude-sub:default";
    const preserved = JSON.stringify({
      phase: "succeeded",
      ownerSessionId: "default",
      message: "already authenticated",
    });
    await kv.put(flowKey, preserved);
    const deployment = env(
      { SHIBA_CLAUDE_SUBSCRIPTION: "1", CLAUDE_SUBSCRIPTION_TOKEN: "setup-token-canary-value" },
      kv,
    );
    const forwardClaude = async () => new Response("no", { status: 401 });
    const done = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "setup-token" }),
        }),
        deployment,
        { forwardClaude },
      ),
    );
    expect(done.providers.find((provider) => provider.id === "claude")?.connection.phase).toBe(
      "connected",
    );
    expect(kv.map.get(flowKey)).toBe(preserved);

    const tested = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/test", { method: "POST", body: "{}" }),
        deployment,
        { forwardClaude },
      ),
    );
    const testedCard = tested.providers.find((provider) => provider.id === "claude");
    expect(testedCard?.connection.testOk).toBe(true);
    expect(testedCard?.connection.message ?? "").not.toContain("AI_GATEWAY_TOKEN");
    expect(testedCard?.connection.message).not.toContain("setup-token-canary-value");
    expect(kv.map.get(flowKey)).toBe(preserved);
  });

  it("does not write a test result over a disconnect that landed during the read", async () => {
    const kv = new FakeKV();
    const deployment = env({ SHIBA_CLAUDE_SUBSCRIPTION: "1" }, kv);
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        { beginOauth: beginWaiting },
      ),
    );
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/verify", {
          method: "POST",
          body: JSON.stringify({}),
        }),
        deployment,
        { completeOauth: async () => ({ ok: true, message: "granted" }) },
      ),
    );
    let release: (value: { ok: boolean; message: string }) => void = () => {};
    let entered: () => void = () => {};
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inspectOauth = () => {
      entered();
      return new Promise<{ ok: boolean; message: string }>((resolve) => {
        release = resolve;
      });
    };
    const testing = handleAcpProviders(
      request("/api/providers/claude/test", { method: "POST", body: "{}" }),
      deployment,
      { inspectOauth },
    );
    await enteredGate;
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/disconnect", { method: "POST", body: "{}" }),
        deployment,
      ),
    );
    release({ ok: true, message: "late" });
    const after = await snapshot(await testing);
    expect(after.providers.find((provider) => provider.id === "claude")?.connection.phase).toBe(
      "disconnected",
    );
  });

  it("does not recreate a provider row when disconnect lands during sign-in confirmation", async () => {
    const kv = new FakeKV();
    const deployment = env({ SHIBA_CLAUDE_SUBSCRIPTION: "1" }, kv);
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        { beginOauth: beginWaiting },
      ),
    );
    let release: (value: { ok: boolean; message: string }) => void = () => {};
    let entered: () => void = () => {};
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const completeOauth = () => {
      entered();
      return new Promise<{ ok: boolean; message: string }>((resolve) => {
        release = resolve;
      });
    };
    const confirming = handleAcpProviders(
      request("/api/providers/claude/verify", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      deployment,
      { completeOauth },
    );
    await enteredGate;
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/disconnect", { method: "POST", body: "{}" }),
        deployment,
      ),
    );
    release({ ok: true, message: "late grant" });
    const after = await snapshot(await confirming);
    const card = after.providers.find((provider) => provider.id === "claude");
    expect(card?.connection.phase).toBe("disconnected");
    expect(card?.connection.testOk).toBeNull();
    expect(card?.connection.message ?? "").not.toContain("late grant");
    expect([...kv.map.keys()].some((key) => key.startsWith("acp_provider:"))).toBe(false);
  });
});

describe("per-org default", () => {
  it("keeps one org's default off another org, and clears it on disconnect", async () => {
    const kv = new FakeKV();
    const deployment = env({ AI_GATEWAY_TOKEN: "gateway-canary" }, kv);
    const connect = (email: string) =>
      handleAcpProviders(
        request(
          "/api/providers/grok/connect",
          { method: "POST", body: JSON.stringify({ mode: "api-key" }) },
          email,
        ),
        deployment,
      );
    await connect("ada@example.com");
    await connect("grace@example.com");
    const ada = await snapshot(
      await handleAcpProviders(
        request(
          "/api/providers/grok/default",
          { method: "POST", body: "{}" },
          "ada@example.com",
        ),
        deployment,
      ),
    );
    expect(ada.org).toBe("ada@example.com");
    expect(ada.defaultProviderId).toBe("grok");

    const grace = await snapshot(
      await handleAcpProviders(
        request("/api/providers", undefined, "grace@example.com"),
        deployment,
      ),
    );
    expect(grace.defaultProviderId).toBeNull();
    expect(grace.providers.find((provider) => provider.id === "grok")?.isDefault).toBe(false);

    const cleared = await snapshot(
      await handleAcpProviders(
        request(
          "/api/providers/grok/disconnect",
          { method: "POST", body: "{}" },
          "ada@example.com",
        ),
        deployment,
      ),
    );
    expect(cleared.defaultProviderId).toBeNull();
    expect(cleared.providers.find((provider) => provider.id === "grok")?.connection.phase).toBe(
      "disconnected",
    );
    expect(JSON.stringify(cleared)).not.toContain("gateway-canary");
  });

  it("refuses to default a provider that is not connected", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/gemini/default", { method: "POST", body: "{}" }),
      env(),
    );
    expect(response?.status).toBe(409);
  });

  it("refuses to test a provider that is not connected", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/gemini/test", { method: "POST", body: "{}" }),
      env(),
    );
    expect(response?.status).toBe(409);
  });
});

describe("Providers page states", () => {
  it("renders waiting, ready, failed, and disconnected cards", () => {
    const base = {
      adapter: "claude-agent-acp",
      packageName: "@agentclientprotocol/claude-agent-acp",
      license: "Apache-2.0",
      harness: "claude-acp",
      protocol: "acp" as const,
      spawn: ["claude-agent-acp"],
      defaultModel: "anthropic/claude-sonnet-4-6",
      docsUrl: "https://agentclientprotocol.com",
      capabilities: {
        streamsText: true,
        toolCalls: true,
        permissions: true,
        setModel: true,
        oauth: true,
        apiKey: true,
        acp: true,
      },
      credentialEnv: ["CLAUDE_SUBSCRIPTION_TOKEN"],
      isDefault: false,
    };
    const html = renderToStaticMarkup(
      React.createElement(ProvidersBoard, {
        snapshot: {
          org: "ada@example.com",
          defaultProviderId: "claude",
          providers: [
            {
              ...base,
              id: "claude",
              label: "Claude Code",
              blurb: "ACP adapter",
              isDefault: true,
              connection: {
                phase: "connected",
                authMode: "oauth",
                message: "setup-token reached the API.",
                userCode: null,
                verificationUri: null,
                expiresAt: null,
                testedAt: 1,
                testOk: true,
              },
            },
            {
              ...base,
              id: "codex",
              label: "Codex",
              blurb: "ACP adapter",
              harness: "codex-acp",
              connection: {
                phase: "waiting",
                authMode: "oauth",
                message: "Open the sign-in page.",
                userCode: null,
                verificationUri: "https://auth.openai.com/oauth/authorize?x=1",
                signInKind: "chatgpt-pkce",
                operatorSteps: ["Paste the http://127.0.0.1 callback URL."],
                expiresAt: 2,
                testedAt: null,
                testOk: null,
              },
            },
            {
              ...base,
              id: "gemini",
              label: "Gemini CLI",
              blurb: "ACP adapter",
              capabilities: { ...base.capabilities, oauth: false },
              connection: {
                phase: "failed",
                authMode: "api-key",
                message: "No credential is provisioned.",
                userCode: null,
                verificationUri: null,
                expiresAt: null,
                testedAt: null,
                testOk: null,
              },
            },
          ],
        },
        loading: false,
        error: null,
        busyId: null,
        actionError: null,
        onRetry: () => {},
        onConnectOauth: () => {},
        onConnectSetupToken: () => {},
        onConnectApiKey: () => {},
        onVerify: () => {},
        onTest: () => {},
        onDisconnect: () => {},
        onDefault: () => {},
      }),
    );
    expect(html).toContain("Org default · Claude Code");
    expect(html).toContain("Ready");
    expect(html).toContain("Open ChatGPT sign-in");
    expect(html).toContain("Callback URL (optional if loopback is running)");
    expect(html).not.toContain("https://chatgpt.com/");
    expect(html).not.toContain("Confirmation code");
    expect(html).toContain("Sign-in pending");
    expect(html).toContain("Connection failed");
    expect(html).toContain("Finish sign-in");
    expect(html).toContain("Test connection");
    expect(html).toContain("Use API credential");
    expect(html).not.toContain("Connect with sign-in</button>");
  });

  it("names the in-flight action on the button that was pressed", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProvidersBoard, {
        snapshot: {
          org: "ada@example.com",
          defaultProviderId: null,
          providers: [
            {
              id: "claude",
              label: "Claude Code",
              blurb: "ACP adapter",
              adapter: "claude-agent-acp",
              packageName: "@agentclientprotocol/claude-agent-acp",
              license: "Apache-2.0",
              harness: "claude-acp",
              protocol: "acp",
              spawn: ["claude-agent-acp"],
              defaultModel: "anthropic/claude-sonnet-4-6",
              docsUrl: "https://agentclientprotocol.com",
              capabilities: {
                streamsText: true,
                toolCalls: true,
                permissions: true,
                setModel: true,
                oauth: true,
                apiKey: true,
                acp: true,
              },
              credentialEnv: ["AI_GATEWAY_TOKEN"],
              isDefault: false,
              connection: {
                phase: "disconnected",
                authMode: null,
                message: null,
                userCode: null,
                verificationUri: null,
                expiresAt: null,
                testedAt: null,
                testOk: null,
              },
            },
          ],
        },
        loading: false,
        error: null,
        busyId: "claude",
        busyAction: "api-key",
        actionError: null,
        onRetry: () => {},
        onConnectOauth: () => {},
        onConnectSetupToken: () => {},
        onConnectApiKey: () => {},
        onVerify: () => {},
        onTest: () => {},
        onDisconnect: () => {},
        onDefault: () => {},
      }),
    );
    expect(html).toContain("Connect with sign-in");
    expect(html).toContain("Working…");
    expect(html).not.toContain("Use API credential");
  });

  it("does not paint an empty adapter catalog when the provider request failed", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProvidersBoard, {
        snapshot: null,
        loading: false,
        error: "Providers request failed: 503",
        busyId: null,
        actionError: null,
        onRetry: () => {},
        onConnectOauth: () => {},
        onConnectSetupToken: () => {},
        onConnectApiKey: () => {},
        onVerify: () => {},
        onTest: () => {},
        onDisconnect: () => {},
        onDefault: () => {},
      }),
    );
    expect(html).toContain("Providers request failed: 503");
    expect(html).toContain("Model connections");
    expect(html).not.toContain(">Sandbox adapters<");
    expect(html).not.toContain("provider-card-");
  });
});
