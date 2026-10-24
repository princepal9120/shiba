import { describe, expect, it } from "vitest";
import { desktopCanSignInClaude, desktopCodexAuthorizationUrl } from "./desktop-provider";

const AUTHORIZE =
  "https://auth.openai.com/oauth/authorize?code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=state-state";

describe("desktopCodexAuthorizationUrl", () => {
  it("accepts an auth.openai.com PKCE URL with a loopback redirect", () => {
    expect(desktopCodexAuthorizationUrl(AUTHORIZE)).toBe(new URL(AUTHORIZE).toString());
  });

  it("accepts Antigravity and xAI loopback redirects", () => {
    const antigravity =
      "https://accounts.google.com/o/oauth2/v2/auth?code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Fcallback&state=state-state";
    const xai =
      "https://auth.x.ai/oauth/authorize?code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A56121%2Fcallback&state=state-state";
    expect(desktopCodexAuthorizationUrl(antigravity)).toBe(new URL(antigravity).toString());
    expect(desktopCodexAuthorizationUrl(xai)).toBe(new URL(xai).toString());
    expect(
      desktopCodexAuthorizationUrl(
        "https://accounts.google.com/o/oauth2/v2/auth?code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcallback&state=state-state",
      ),
    ).toBeNull();
  });

  it("rejects a device page, another host, and a missing challenge", () => {
    expect(desktopCodexAuthorizationUrl("https://auth.openai.com/codex/device")).toBeNull();
    expect(
      desktopCodexAuthorizationUrl(
        "https://evil.example/oauth?code_challenge=a&code_challenge_method=S256",
      ),
    ).toBeNull();
    expect(
      desktopCodexAuthorizationUrl(
        "http://auth.openai.com/oauth?code_challenge=a&code_challenge_method=S256&redirect_uri=http://127.0.0.1:1455/auth/callback",
      ),
    ).toBeNull();
  });
});

describe("desktopCanSignInClaude", () => {
  it("is true only for Claude when the shell exposes startClaudeLogin", () => {
    expect(
      desktopCanSignInClaude({ startClaudeLogin: () => Promise.resolve({ ok: true }) }, "claude"),
    ).toBe(true);
    expect(
      desktopCanSignInClaude({ startClaudeLogin: () => Promise.resolve({ ok: true }) }, "codex"),
    ).toBe(false);
    expect(desktopCanSignInClaude(undefined, "claude")).toBe(false);
  });
});
