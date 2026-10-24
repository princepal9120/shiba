import { describe, expect, it } from "vitest";
import {
  denyUnscopedGitHub,
  forwardAnthropic,
  forwardGitHubScoped,
  forwardGoogle,
  forwardOpenAI,
  forwardXAI,
  GATEWAY_PROVIDERS,
  isAllowedGitHubRequest,
  isWithinRepoScope,
  type EgressEnv,
} from "../src/egress.js";

const env = { GITHUB_TOKEN: "ghp-secret" } as unknown as EgressEnv;

describe("isAllowedGitHubRequest", () => {
  it("allows read-only fetch traffic", () => {
    expect(isAllowedGitHubRequest("GET", "/acme/widgets.git/info/refs")).toBe(true);
    expect(isAllowedGitHubRequest("HEAD", "/acme/widgets/info/refs")).toBe(true);
    expect(isAllowedGitHubRequest("POST", "/acme/widgets.git/git-upload-pack")).toBe(true);
  });

  it("refuses push and every other method", () => {
    expect(isAllowedGitHubRequest("POST", "/acme/widgets.git/git-receive-pack")).toBe(false);
    expect(isAllowedGitHubRequest("DELETE", "/acme/widgets")).toBe(false);
    expect(isAllowedGitHubRequest("PUT", "/acme/widgets")).toBe(false);
  });
});

describe("isWithinRepoScope", () => {
  it("matches the approved repo and its sub-paths", () => {
    expect(isWithinRepoScope("/acme/widgets", "/acme/widgets")).toBe(true);
    expect(isWithinRepoScope("/acme/widgets.git", "/acme/widgets")).toBe(true);
    expect(isWithinRepoScope("/acme/widgets.git/info/refs", "/acme/widgets")).toBe(true);
    expect(isWithinRepoScope("/acme/widgets/info/refs", "/acme/widgets")).toBe(true);
  });

  it("refuses a sibling repo sharing the prefix", () => {
    expect(isWithinRepoScope("/acme/widgets-evil", "/acme/widgets")).toBe(false);
    expect(isWithinRepoScope("/acme/widgetsx.git", "/acme/widgets")).toBe(false);
  });

  it("refuses a different owner and an empty scope", () => {
    expect(isWithinRepoScope("/other/widgets", "/acme/widgets")).toBe(false);
    expect(isWithinRepoScope("/acme/widgets", "/")).toBe(false);
    expect(isWithinRepoScope("/acme/widgets", "")).toBe(false);
  });

  it("compares case-insensitively, as GitHub paths are", () => {
    expect(isWithinRepoScope("/Acme/Widgets.git", "/acme/widgets")).toBe(true);
  });
});

describe("github.com egress handlers", () => {
  it("refuses unscoped github traffic by default, with no credential", async () => {
    const response = await denyUnscopedGitHub();
    expect(response.status).toBe(403);
  });

  it("refuses a run whose scope was never approved", async () => {
    const response = await forwardGitHubScoped(
      new Request("https://github.com/acme/widgets.git/info/refs"),
      env,
      {},
    );
    expect(response.status).toBe(403);
  });

  it("refuses a repo outside the approved scope", async () => {
    const response = await forwardGitHubScoped(
      new Request("https://github.com/acme/other-repo.git/info/refs"),
      env,
      { params: { allowedPath: "/acme/widgets" } },
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("outside the approved scope");
  });

  it("refuses a prefix-confusion sibling repo", async () => {
    const response = await forwardGitHubScoped(
      new Request("https://github.com/acme/widgets-evil.git/info/refs"),
      env,
      { params: { allowedPath: "/acme/widgets" } },
    );
    expect(response.status).toBe(403);
  });

  it("refuses a non-github destination even when scoped", async () => {
    const response = await forwardGitHubScoped(
      new Request("https://evil.example.com/acme/widgets"),
      env,
      { params: { allowedPath: "/acme/widgets" } },
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Invalid repository destination");
  });

  it("forwards the approved repo with the credential attached", async () => {
    const seen: Request[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input as RequestInfo, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const response = await forwardGitHubScoped(
        new Request("https://github.com/acme/widgets.git/info/refs"),
        env,
        { params: { allowedPath: "/acme/widgets" } },
      );
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.headers.get("Authorization")).toBe(
        `Basic ${btoa("x-access-token:ghp-secret")}`,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("never attaches the credential on a refused request", async () => {
    const seen: Request[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input as RequestInfo, init));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      await forwardGitHubScoped(
        new Request("https://github.com/acme/other-repo.git/info/refs"),
        env,
        { params: { allowedPath: "/acme/widgets" } },
      );
      expect(seen).toHaveLength(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("provider egress forwarders (T22)", () => {
  function gatewayEnv(seen: { slug?: string }): EgressEnv {
    return {
      GATEWAY_ID: "default",
      AI: {
        gateway: () => ({
          getUrl: async (slug: string) => { seen.slug = slug; return "https://gateway.example/v1"; },
        }),
      },
    } as unknown as EgressEnv;
  }

  it("maps each provider host to its AI Gateway slug", () => {
    expect(GATEWAY_PROVIDERS).toEqual({
      "generativelanguage.googleapis.com": "google-ai-studio",
      "api.anthropic.com": "anthropic",
      "api.openai.com": "openai",
      "api.x.ai": "grok",
      "opencode.ai": "opencode-go",
    });
  });

  it.each([
    [forwardGoogle, "https://generativelanguage.googleapis.com/v1/x", "google-ai-studio"],
    [forwardAnthropic, "https://api.anthropic.com/v1/messages", "anthropic"],
    [forwardOpenAI, "https://api.openai.com/v1/responses", "openai"],
    [forwardXAI, "https://api.x.ai/v1/chat/completions", "grok"],
  ])("%# routes its own host through the gateway", async (forward, url, slug) => {
    const seen: { slug?: string } = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    try {
      const response = await forward(new Request(url, { method: "POST" }), gatewayEnv(seen));
      expect(response.status).toBe(200);
      expect(seen.slug).toBe(slug);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses a host that is not its own, so one harness cannot use another's forwarder", async () => {
    const seen: { slug?: string } = {};
    const wrong = await forwardAnthropic(
      new Request("https://api.openai.com/v1/responses", { method: "POST" }),
      gatewayEnv(seen),
    );
    expect(wrong.status).toBe(403);
    expect(seen.slug).toBeUndefined();
  });

  it("refuses a method other than GET or POST", async () => {
    const response = await forwardAnthropic(
      new Request("https://api.anthropic.com/v1/messages", { method: "DELETE" }),
      gatewayEnv({}),
    );
    expect(response.status).toBe(405);
  });
});

