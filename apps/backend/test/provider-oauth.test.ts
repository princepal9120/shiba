/**
 * Provider OAuth — mocked vendor endpoints (login, exchange, refresh, egress).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  beginAntigravityOAuth,
  exchangeAntigravityCode,
  parseAntigravityCallbackCode,
  refreshAntigravityToken,
} from "../src/provider-oauth/antigravity.js";
import { resolveAntigravityOAuthClient } from "../src/provider-oauth/antigravity-client.js";
import { beginCursorOAuth, pollCursorOnce, pollCursorOAuth, refreshCursorToken } from "../src/provider-oauth/cursor.js";
import {
  beginXaiOAuth,
  exchangeXaiCode,
  parseXaiCallbackCode,
  refreshXaiToken,
  XAI_REDIRECT_URI,
} from "../src/provider-oauth/xai.js";
import {
  forwardAntigravityUser,
  forwardCursorUser,
  forwardXAI,
  forwardXaiUser,
  type EgressEnv,
} from "../src/egress.js";
import { UserProviderOAuth, userProviderOAuthStub } from "../src/user-provider-oauth-do.js";
import { antigravitySubscriptionHarness } from "../src/harness/antigravity-subscription.js";
import { cursorSubscriptionHarness } from "../src/harness/cursor-subscription.js";
import { grokHarness } from "../src/harness/grok.js";
import { assertHarnessAuthorized } from "../src/auth/index.js";
import type { Env } from "../src/env.js";
import { encryptAuthJson } from "../src/subscription-credentials.js";
import { saveUserOAuthRecord } from "../src/user-provider-oauth-store.js";

const KEY = "ab".repeat(32);
const MOCK_ANTIGRAVITY_CLIENT = resolveAntigravityOAuthClient({
  GOOGLE_ANTIGRAVITY_CLIENT_SECRET: "test-secret",
});

class FakeD1 {
  private rows = new Map<string, string>();
  prepare(sql: string) {
    const isSelect = sql.includes("SELECT");
    const isDelete = sql.includes("DELETE");
    return {
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (!isSelect) return null;
          const key = `${args[0]}:${args[1]}:${args[2]}`;
          const cipher = this.rows.get(key);
          return cipher ? { auth_cipher: cipher } : null;
        },
        run: async () => {
          if (isDelete) {
            const key = `${args[0]}:${args[1]}:${args[2]}`;
            this.rows.delete(key);
            return {};
          }
          const key = `${args[0]}:${args[1]}:${args[2]}`;
          this.rows.set(key, String(args[3]));
          return {};
        },
      }),
    };
  }
  async batch() {
    return [];
  }
}

class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string, opts?: { type?: string }) {
    const v = this.map.get(key);
    if (opts?.type === "text") return v ?? null;
    return v ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

function oauthEnv(stubFetch: typeof fetch, d1 = new FakeD1()): EgressEnv {
  const ns = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: stubFetch,
    }),
  };
  return {
    AGENT_TOKENS: new FakeKV() as unknown as EgressEnv["AGENT_TOKENS"],
    AGENT_AUDIT: d1 as unknown as EgressEnv["AGENT_AUDIT"],
    MODEL_CREDENTIAL_KEY: KEY,
    UserProviderOAuth: ns as unknown as EgressEnv["UserProviderOAuth"],
    GOOGLE_ANTIGRAVITY_CLIENT_SECRET: "test-secret",
    AI_GATEWAY_TOKEN: "gw-token",
    GATEWAY_ID: "default",
    AI: {
      gateway: () => ({
        getUrl: async () => "https://gateway.example/api.x.ai",
      }),
    },
  } as unknown as EgressEnv;
}

describe("provider-oauth modules", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("antigravity: exchange, refresh, callback host/state, and authenticated egress", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        const body = String(init?.body ?? "");
        if (body.includes("authorization_code")) {
          return Response.json({
            access_token: "agy-access",
            refresh_token: "agy-refresh",
            expires_in: 3600,
          });
        }
        return Response.json({
          access_token: "agy-access-2",
          refresh_token: "agy-refresh",
          expires_in: 3600,
        });
      }
      if (url.includes("loadCodeAssist")) {
        return Response.json({ projectId: "cca-project-1" });
      }
      if (url.includes("cloudcode-pa.googleapis.com/v1/models")) {
        const auth = new Headers(init?.headers).get("Authorization");
        return new Response(auth === "Bearer agy-access" ? "ok" : "no", { status: auth ? 200 : 401 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const begin = await beginAntigravityOAuth(MOCK_ANTIGRAVITY_CLIENT);
    expect(begin.authorizeUrl).toContain("accounts.google.com");
    const record = await exchangeAntigravityCode(MOCK_ANTIGRAVITY_CLIENT, "code-1", begin.codeVerifier);
    expect(record.projectId).toBe("cca-project-1");

    const refreshed = await refreshAntigravityToken(MOCK_ANTIGRAVITY_CLIENT, record.refreshToken);
    expect(refreshed.accessToken).toBe("agy-access-2");

    expect(() =>
      parseAntigravityCallbackCode("https://evil.example/cb?state=x&code=y", begin.state),
    ).toThrow(/127\.0\.0\.1/);
    expect(() =>
      parseAntigravityCallbackCode(
        `http://127.0.0.1:51121/callback?state=wrong&code=y`,
        begin.state,
      ),
    ).toThrow(/does not match/);

    const egressEnv = oauthEnv(async (input) => {
      const url = String(input);
      if (url.includes("/access?")) {
        return Response.json({ accessToken: "agy-access", projectId: "cca-project-1" });
      }
      return originalFetch(input);
    });

    const response = await forwardAntigravityUser(
      new Request("https://cloudcode-pa.googleapis.com/v1/models", { method: "GET" }),
      egressEnv,
      { params: { userId: "ada" } },
    );
    expect(response.status).toBe(200);
  });

  it("antigravity egress without user OAuth preserves in-container profile bearer on Cloud Code hosts", async () => {
    let seenAuth: string | null = null;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers(init?.headers as HeadersInit | undefined);
      seenAuth = h.get("authorization");
      return new Response(seenAuth === "Bearer agy-profile-token" ? "ok" : "no", {
        status: seenAuth === "Bearer agy-profile-token" ? 200 : 401,
      });
    }) as typeof fetch;

    const egressEnv = oauthEnv(async (input) => {
      if (String(input).includes("/access?")) {
        return new Response("", { status: 404 });
      }
      return globalThis.fetch(input);
    });

    const response = await forwardAntigravityUser(
      new Request("https://cloudcode-pa.googleapis.com/v1internal:generateContent", {
        method: "POST",
        headers: {
          authorization: "Bearer agy-profile-token",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      egressEnv,
      { params: { userId: "ada" } },
    );
    expect(response.status).toBe(200);
    expect(seenAuth).toBe("Bearer agy-profile-token");
  });

  it("antigravity egress without user OAuth still strips authorization on non-Cloud-Code hosts", async () => {
    let seenAuth: string | null = "unset";
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h =
        init?.headers instanceof Headers
          ? init.headers
          : new Headers(init?.headers as HeadersInit | undefined);
      seenAuth = h.get("authorization");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const egressEnv = oauthEnv(async (input) => {
      if (String(input).includes("/access?")) {
        return new Response("", { status: 404 });
      }
      return globalThis.fetch(input);
    });

    await forwardAntigravityUser(
      new Request("https://generativelanguage.googleapis.com/v1/models", {
        method: "GET",
        headers: { authorization: "Bearer agy-profile-token" },
      }),
      egressEnv,
      { params: { userId: "ada" } },
    );
    expect(seenAuth).toBeNull();
  });

  it("cursor: single poll, refresh, terminal rejection, and authenticated egress", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/poll")) {
        return Response.json({ accessToken: "cur-access", refreshToken: "cur-refresh" });
      }
      if (url.includes("/auth/exchange_user_api_key")) {
        return Response.json({ accessToken: "cur-access-2", refreshToken: "cur-refresh" });
      }
      if (url.includes("api2.cursor.sh/health")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const begin = await beginCursorOAuth();
    const once = await pollCursorOnce(begin.uuid, begin.verifier);
    expect(once.status).toBe("connected");

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/poll")) return new Response("", { status: 403 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    await expect(pollCursorOnce(begin.uuid, begin.verifier)).rejects.toThrow(/rejected/);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/poll")) {
        return Response.json({ accessToken: "cur-access", refreshToken: "cur-refresh" });
      }
      if (url.includes("/auth/exchange_user_api_key")) {
        return Response.json({ accessToken: "cur-access-2", refreshToken: "cur-refresh" });
      }
      if (url.includes("api2.cursor.sh/health")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const record = await pollCursorOAuth(begin.uuid, begin.verifier, { baseDelayMs: 1, maxAttempts: 2 });
    expect(record.accessToken).toBe("cur-access");
    const refreshed = await refreshCursorToken(record.refreshToken);
    expect(refreshed.accessToken).toBe("cur-access-2");

    const egressEnv = oauthEnv(async (input) => {
      if (String(input).includes("/access?")) {
        return Response.json({ accessToken: "cur-access-2" });
      }
      return originalFetch(input);
    });
    const response = await forwardCursorUser(
      new Request("https://api2.cursor.sh/health", { method: "GET" }),
      egressEnv,
      { params: { userId: "ada", account: "default" } },
    );
    expect(response.status).toBe(200);
  });

  it("xai: nonce-bound id_token, state/host checks, refresh, and authenticated egress", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return Response.json({
          authorization_endpoint: "https://auth.x.ai/authorize",
          token_endpoint: "https://auth.x.ai/token",
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const begin = await beginXaiOAuth();
    expect(begin.nonce).toBeTruthy();
    const idPayload = btoa(JSON.stringify({ sub: "u1", email: "a@x.ai", nonce: begin.nonce }));
    const idToken = `hdr.${idPayload}.sig`;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth.x.ai/token")) {
        const body = String(init?.body ?? "");
        if (body.includes("authorization_code")) {
          return Response.json({
            access_token: "xai-access",
            refresh_token: "xai-refresh",
            expires_in: 3600,
            id_token: idToken,
          });
        }
        return Response.json({
          access_token: "xai-access-2",
          refresh_token: "xai-refresh",
          expires_in: 3600,
        });
      }
      if (url.includes("api.x.ai/v1/models")) {
        const auth = new Headers(init?.headers).get("Authorization");
        return new Response(auth === "Bearer xai-access" ? "ok" : "no", { status: auth ? 200 : 401 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const record = await exchangeXaiCode("code-x", begin.codeVerifier, begin.tokenEndpoint, begin.nonce);
    expect(record.accessToken).toBe("xai-access");

    const badIdPayload = btoa(JSON.stringify({ sub: "u1", email: "a@x.ai", nonce: "wrong" }));
    const badIdToken = `hdr.${badIdPayload}.sig`;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth.x.ai/token") && String(init?.body ?? "").includes("authorization_code")) {
        return Response.json({
          access_token: "xai-access",
          refresh_token: "xai-refresh",
          expires_in: 3600,
          id_token: badIdToken,
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    await expect(
      exchangeXaiCode("code-x", begin.codeVerifier, begin.tokenEndpoint, begin.nonce),
    ).rejects.toThrow(/nonce/);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return Response.json({
          authorization_endpoint: "https://auth.x.ai/authorize",
          token_endpoint: "https://auth.x.ai/token",
        });
      }
      if (url.includes("auth.x.ai/token")) {
        const body = String(init?.body ?? "");
        if (body.includes("refresh_token")) {
          return Response.json({
            access_token: "xai-access-2",
            refresh_token: "xai-refresh",
            expires_in: 3600,
          });
        }
      }
      if (url.includes("api.x.ai/v1/models")) {
        const auth = new Headers(init?.headers).get("Authorization");
        return new Response(auth === "Bearer xai-access" ? "ok" : "no", { status: auth ? 200 : 401 });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    expect(() =>
      parseXaiCallbackCode(`http://127.0.0.1:56121/callback?state=bad&code=c`, begin.state),
    ).toThrow(/does not match/);

    const refreshed = await refreshXaiToken(record.refreshToken, begin.tokenEndpoint);
    expect(refreshed.accessToken).toBe("xai-access-2");

    const egressEnv = oauthEnv(async (input) => {
      if (String(input).includes("/access?")) {
        return Response.json({ accessToken: "xai-access" });
      }
      return originalFetch(input);
    });
    const response = await forwardXaiUser(
      new Request("https://api.x.ai/v1/models", { method: "POST", body: "{}" }),
      egressEnv,
      { params: { userId: "ada" } },
    );
    expect(response.status).toBe(200);
  });

  it("grok egress falls back to pasted xAI key when OAuth is absent", async () => {
    const kv = new FakeKV();
    const secret = "xai-user-pasted-key-abcdefghij";
    const cipher = await encryptAuthJson(secret, KEY, "installation", "ada", "xai");
    await kv.put("user_provider_secret:ada:xai", cipher);
    await kv.put("user_provider_owner:ada:xai", "ada");

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/access?")) {
        return new Response("", { status: 404 });
      }
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      const auth = headers.get("Authorization");
      if (auth === `Bearer ${secret}`) return new Response("ok");
      return new Response("no", { status: 401 });
    }) as typeof fetch;

    const egressEnv = oauthEnv(async (input) => globalThis.fetch(input), new FakeD1());
    egressEnv.AGENT_TOKENS = kv as unknown as EgressEnv["AGENT_TOKENS"];

    const response = await forwardXaiUser(
      new Request("https://api.x.ai/v1/chat/completions", { method: "POST", body: "{}" }),
      egressEnv,
      { params: { userId: "ada" }, orgId: "ada" },
    );
    expect(response.status).toBe(200);
    const overrides = grokHarness.egressOverrides!({
      initiatorUserId: "ada",
      task: "hi",
      repoUrl: "https://github.com/a/b",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "run-12345678901234",
      codingModel: "xai/grok-4.6",
    });
    expect(overrides[0]?.handler).toBe("xaiUser");
  });
});

describe("AGENTS.md tradeoff — provider OAuth egress", () => {
  it("credentials never enter the container for antigravity/cursor/grok user lanes", () => {
    const secret = "oauth-access-token-value";
    const input = {
      initiatorUserId: "ada",
      task: "t",
      repoUrl: "https://github.com/a/b",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "run-12345678901234",
      codingModel: "google-subscription/antigravity",
      authAccount: "default",
    };
    const agyEnv = antigravitySubscriptionHarness.env(input);
    const agyFiles = antigravitySubscriptionHarness.configFile(input);
    const agyArgv = antigravitySubscriptionHarness.buildArgv(input, "/workspace");
    const agyBlob = JSON.stringify({ env: agyEnv, files: agyFiles, argv: agyArgv });
    expect(agyBlob).not.toContain(secret);

    const cursorInput = { ...input, codingModel: "cursor-subscription/auto" };
    const curEnv = cursorSubscriptionHarness.env(cursorInput, null);
    expect(curEnv.CURSOR_API_KEY).not.toContain(secret);
    expect(JSON.stringify(curEnv)).not.toContain(secret);

    const grokInput = { ...input, codingModel: "xai/grok-4.6" };
    const grokEnv = grokHarness.env(grokInput, null);
    expect(grokEnv.XAI_API_KEY).toBe("shiba-dummy-key");
  });
});

describe("assertHarnessAuthorized with per-user OAuth", () => {
  it("allows cursor-subscription and antigravity-subscription when OAuth is connected", async () => {
    const d1 = new FakeD1();
    const env = oauthEnv(async () => Response.json({ ok: true }), d1) as Env;
    await saveUserOAuthRecord(env, "ada", "cursor", {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600_000,
      savedAt: Date.now(),
    });
    await expect(
      assertHarnessAuthorized(env, cursorSubscriptionHarness, {
        initiatorUserId: "ada",
        authAccount: "default",
        task: "t",
        repoUrl: "https://github.com/a/b",
        baseBranch: "main",
        publishPullRequest: false,
        sandboxId: "run-12345678901234",
        codingModel: "cursor-subscription/auto",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("UserProviderOAuth durable object", () => {
  it("exports stub helper", () => {
    const env = oauthEnv(async () => Response.json({ ok: true }));
    const stub = userProviderOAuthStub(env, "user-1");
    expect(stub).toBeTruthy();
  });

  it("class is registered for wrangler", () => {
    expect(UserProviderOAuth).toBeDefined();
  });
});
