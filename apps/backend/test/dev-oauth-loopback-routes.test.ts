import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEV_OAUTH_LOOPBACK_HEADER,
  handleDevOAuthLoopback,
  resetDevOAuthLoopbackForTests,
} from "../src/dev-oauth-loopback-routes.js";
import type { Env } from "../src/env.js";
import * as acpProviders from "../src/acp-providers.js";

const SECRET = "a".repeat(32);

function env(overrides: Partial<Env> = {}): Env {
  return {
    SHIBA_DEV_OAUTH_LOOPBACK_SECRET: SECRET,
    BETTER_AUTH_SECRET: "b".repeat(32),
    ...overrides,
  } as Env;
}

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

beforeEach(() => {
  resetDevOAuthLoopbackForTests();
  vi.restoreAllMocks();
});

describe("handleDevOAuthLoopback", () => {
  const callback =
    "http://127.0.0.1:51121/callback?code=abc&state=pending-state-1";

  it("rejects POST without the dev loopback secret", async () => {
    const res = await handleDevOAuthLoopback(
      req("http://127.0.0.1:8788/api/dev/oauth-loopback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: callback }),
      }),
      env(),
    );
    expect(res?.status).toBe(401);
  });

  it("stores by state and returns a single callback for the pending sign-in", async () => {
    vi.spyOn(acpProviders, "waitingProviderOauthState").mockResolvedValue("pending-state-1");
    const openEnv = env({ BETTER_AUTH_SECRET: undefined });

    const post = await handleDevOAuthLoopback(
      req("http://127.0.0.1:8788/api/dev/oauth-loopback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DEV_OAUTH_LOOPBACK_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: callback }),
      }),
      openEnv,
    );
    expect(post?.status).toBe(200);

    const get = await handleDevOAuthLoopback(
      req(
        "http://127.0.0.1:8788/api/dev/oauth-loopback?state=pending-state-1&provider=gemini",
      ),
      openEnv,
    );
    expect(get?.status).toBe(200);
    const body = (await get?.json()) as { callbackUrl: string };
    expect(body.callbackUrl).toBe(callback);

    const again = await handleDevOAuthLoopback(
      req(
        "http://127.0.0.1:8788/api/dev/oauth-loopback?state=pending-state-1&provider=gemini",
      ),
      openEnv,
    );
    const empty = (await again?.json()) as { callbackUrl: string | null };
    expect(empty.callbackUrl).toBeNull();
  });

  it("returns 404 when state does not match the pending sign-in", async () => {
    vi.spyOn(acpProviders, "waitingProviderOauthState").mockResolvedValue("other-state");
    const openEnv = env({ BETTER_AUTH_SECRET: undefined });

    await handleDevOAuthLoopback(
      req("http://127.0.0.1:8788/api/dev/oauth-loopback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DEV_OAUTH_LOOPBACK_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: callback }),
      }),
      openEnv,
    );

    const get = await handleDevOAuthLoopback(
      req(
        "http://127.0.0.1:8788/api/dev/oauth-loopback?state=pending-state-1&provider=gemini",
      ),
      openEnv,
    );
    expect(get?.status).toBe(404);
  });

  it("requires a session when better-auth is configured", async () => {
    vi.spyOn(acpProviders, "waitingProviderOauthState").mockResolvedValue("pending-state-1");
    await handleDevOAuthLoopback(
      req("http://127.0.0.1:8788/api/dev/oauth-loopback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DEV_OAUTH_LOOPBACK_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: callback }),
      }),
      env(),
    );

    const get = await handleDevOAuthLoopback(
      req(
        "http://127.0.0.1:8788/api/dev/oauth-loopback?state=pending-state-1&provider=gemini",
      ),
      env({ BETTER_AUTH_SECRET: "c".repeat(32) }),
    );
    expect(get?.status).toBe(401);
  });

  it("is hidden off loopback hosts", async () => {
    const res = await handleDevOAuthLoopback(
      req("https://shiba.example/api/dev/oauth-loopback", { method: "POST", body: "{}" }),
      env(),
    );
    expect(res?.status).toBe(404);
  });
});
