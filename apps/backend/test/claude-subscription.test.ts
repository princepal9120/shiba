/**
 * T48 — `claude-subscription` harness (PLAN.md §18.10). Proves the three
 * non-negotiables without a live credential:
 *   1. opt-in: absent SHIBA_CLAUDE_SUBSCRIPTION the harness is unregistered,
 *      uncataloged, unselectable — not merely unwired;
 *   2. the setup-token never enters the container — the sandbox gets a
 *      placeholder .credentials.json and no ANTHROPIC_API_KEY, while the
 *      dedicated egress branch attaches the Bearer out-of-band;
 *   3. resume-same-key is a decider rule (`input_conflict`), not UI policy.
 */
import { describe, expect, it, vi } from "vitest";

// @cloudflare/sandbox's containers sub-dep doesn't resolve under Node ESM;
// the test only needs src/sandbox.ts's static handler registry, so stub the
// package surface the module extends.
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  Container: class {},
  proxyToSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getContainer: vi.fn(),
}));
import { decideRunTransition, type DelegatedRun, type QueuedRunInput } from "@shiba/shared";
import { agentCliCatalog } from "../src/harness/catalog.js";
import {
  claudeSubscriptionHarness,
  claudeSubscriptionConfigDir,
  claudeSubscriptionCredentialsFile,
  ClaudeUsageLimitError,
  CLAUDE_SUBSCRIPTION_HOSTS,
  CLAUDE_SUBSCRIPTION_PLACEHOLDER,
  hasConflictingOAuthCredential,
} from "../src/harness/claude-subscription.js";
import { ClaudeCodeErrorEvent } from "../src/harness/claude-code.js";
import { resolveHarness, SANDBOX_HARNESS_NAMES, sandboxHarnessNames } from "../src/harness/index.js";
import { forwardClaudeSubscription, GATEWAY_PROVIDERS, type EgressEnv } from "../src/egress.js";
import { assertHarnessAuthorized } from "../src/auth/index.js";
import { claudeSubscriptionSecretName } from "../src/auth/claude-subscription.js";
import { Sandbox } from "../src/sandbox.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const ENABLED = { SHIBA_CLAUDE_SUBSCRIPTION: "1" };
const SUB_MODEL = "anthropic-subscription/claude-sonnet-4-6";

const input = (extra: Partial<CodingTaskInput> = {}): CodingTaskInput => ({
  repoUrl: "https://github.com/acme/widgets",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: SUB_MODEL,
  ...extra,
});

describe("opt-in gate (§18.10 non-negotiable 2)", () => {
  it("is unregistered without the flag — not selectable, not listed", () => {
    expect(() => resolveHarness("claude-subscription")).toThrow(/Unknown agent harness/);
    expect(() => resolveHarness("claude-subscription", {})).toThrow(/Unknown agent harness/);
    expect(() => resolveHarness("claude-subscription", { SHIBA_CLAUDE_SUBSCRIPTION: "0" })).toThrow(
      /Unknown agent harness/,
    );
    expect(SANDBOX_HARNESS_NAMES).not.toContain("claude-subscription");
    expect(agentCliCatalog({}).map((a) => a.id)).not.toContain("claude-subscription");
  });

  it("SHIBA_CLAUDE_SUBSCRIPTION=1 registers it everywhere it should appear", () => {
    expect(resolveHarness("claude-subscription", ENABLED).name).toBe("claude-subscription");
    expect(sandboxHarnessNames(ENABLED)).toContain("claude-subscription");
    const entry = agentCliCatalog({ ...ENABLED }).find((a) => a.id === "claude-subscription");
    expect(entry).toBeDefined();
    expect(entry?.credential?.label).toBe("CLAUDE_SUBSCRIPTION_TOKEN");
    expect(entry?.credential?.configured).toBe(false);
    expect(entry?.credential?.setupHint).toContain("claude setup-token");
    const configured = agentCliCatalog({
      ...ENABLED,
      CLAUDE_SUBSCRIPTION_TOKEN: "sk-ant-oat01-real",
    }).find((a) => a.id === "claude-subscription");
    expect(configured?.credential?.configured).toBe(true);
  });
});

describe("the token never enters the container", () => {
  it("env() carries CLAUDE_CONFIG_DIR and no Anthropic key material at all", () => {
    const env = claudeSubscriptionHarness.env(input());
    expect(env.CLAUDE_CONFIG_DIR).toBe("/root/.shiba/claude/default");
    for (const [key, value] of Object.entries(env)) {
      expect(key).not.toContain("ANTHROPIC");
      expect(key).not.toContain("KEY");
      expect(value).not.toContain("sk-ant");
    }
  });

  it("configFile is a placeholder credentials file under the config dir, never HOME", () => {
    const dir = claudeSubscriptionConfigDir(input({ authAccount: "work" }));
    const file = claudeSubscriptionCredentialsFile(dir);
    expect(dir).toBe("/root/.shiba/claude/work");
    expect(file.path).toBe("/root/.shiba/claude/work/.credentials.json");
    const parsed = JSON.parse(file.contents) as {
      claudeAiOauth: { accessToken: string };
    };
    expect(parsed.claudeAiOauth.accessToken).toBe(CLAUDE_SUBSCRIPTION_PLACEHOLDER);
    expect(file.contents).not.toContain("sk-ant");
  });

  it("hasConflictingOAuthCredential refuses a real cached login, accepts the placeholder", () => {
    const real = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-real", refreshToken: "rt" },
    });
    expect(hasConflictingOAuthCredential(real)).toBe(true);
    const placeholder = claudeSubscriptionCredentialsFile("/x").contents;
    expect(hasConflictingOAuthCredential(placeholder)).toBe(false);
    expect(hasConflictingOAuthCredential("not json")).toBe(false);
    expect(hasConflictingOAuthCredential("{}")).toBe(false);
  });
});

describe("egress isolation", () => {
  it("api.anthropic.com stays on the gateway map — subscription rides an override branch", () => {
    expect(GATEWAY_PROVIDERS["api.anthropic.com"]).toBe("anthropic");
    expect(Sandbox.outboundHandlers?.claudeSubscription).toBe(forwardClaudeSubscription);
  });

  it("egressOverrides pins every subscription host to the dedicated handler with the account name", () => {
    const overrides = claudeSubscriptionHarness.egressOverrides!(input({ authAccount: "work" }));
    expect(overrides.map((o) => o.host).sort()).toEqual([...CLAUDE_SUBSCRIPTION_HOSTS].sort());
    for (const o of overrides) {
      expect(o.handler).toBe("claudeSubscription");
      expect(o.params).toEqual({ account: "work" });
      expect(JSON.stringify(o.params)).not.toContain("sk-ant");
    }
  });

  it("egressHosts is the enumerated subscription set, not PROVIDER_HOSTS reuse", () => {
    expect(claudeSubscriptionHarness.egressHosts(SUB_MODEL)).toEqual([
      "api.anthropic.com",
      "claude.ai",
    ]);
    expect(() => claudeSubscriptionHarness.egressHosts("anthropic/claude-sonnet-4-6")).toThrow(
      /Unsupported coding model/,
    );
  });

  it("forwarder refuses non-subscription hosts and non-GET/POST, 503s on missing secret", async () => {
    const env = { CLAUDE_SUBSCRIPTION_TOKEN: "sk-ant-oat01-real" } as unknown as EgressEnv;
    expect(
      (await forwardClaudeSubscription(new Request("https://evil.example.com/x"), env)).status,
    ).toBe(403);
    expect(
      (
        await forwardClaudeSubscription(
          new Request("https://api.anthropic.com/v1/messages", { method: "DELETE" }),
          env,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await forwardClaudeSubscription(
          new Request("https://api.anthropic.com/v1/models?limit=1"),
          {} as unknown as EgressEnv,
        )
      ).status,
    ).toBe(503);
  });

  it("forwarder attaches Bearer + oauth beta on the wire; the placeholder never leaves", async () => {
    const seen: { auth?: string | null; beta?: string | null; url?: string } = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (req: RequestInfo | URL, init?: RequestInit) => {
      seen.url = req instanceof Request ? req.url : String(req);
      const headers =
        init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as HeadersInit);
      seen.auth = headers.get("authorization");
      seen.beta = headers.get("anthropic-beta");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const env = { CLAUDE_SUBSCRIPTION_TOKEN_WORK: "sk-ant-oat01-work" } as unknown as EgressEnv;
      const response = await forwardClaudeSubscription(
        new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
        env,
        { params: { account: "work" } },
      );
      expect(response.status).toBe(200);
      expect(seen.auth).toBe("Bearer sk-ant-oat01-work");
      expect(seen.beta).toBe("oauth-2025-04-20");
      expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("per-account secret naming: default → CLAUDE_SUBSCRIPTION_TOKEN", () => {
    expect(claudeSubscriptionSecretName("default")).toBe("CLAUDE_SUBSCRIPTION_TOKEN");
    expect(claudeSubscriptionSecretName("work-acct")).toBe("CLAUDE_SUBSCRIPTION_TOKEN_WORK_ACCT");
  });
});

describe("harness shape", () => {
  it("buildArgv is the claude-code shape with the provider prefix stripped", () => {
    const argv = claudeSubscriptionHarness.buildArgv(input(), "/workspace/run-1");
    expect(argv.slice(0, 8)).toEqual([
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--model",
    ]);
    expect(argv[8]).toBe("claude-sonnet-4-6");
    expect(argv.slice(9)).toEqual(["--add-dir", "/workspace/run-1", "Fix it."]);
  });

  it("declares the auth requirement with the account-scoped instanceId", () => {
    expect(claudeSubscriptionHarness.auth?.instanceId(input({ authAccount: "work" }))).toBe(
      "claude-sub:work",
    );
    expect(claudeSubscriptionHarness.auth?.instanceId(input())).toBe("claude-sub:default");
  });

  it("continuationKey is claude:home:<configDir> per account", () => {
    expect(claudeSubscriptionHarness.continuationKey!(input())).toBe(
      "claude:home:/root/.shiba/claude/default",
    );
    expect(claudeSubscriptionHarness.continuationKey!(input({ authAccount: "work" }))).toBe(
      "claude:home:/root/.shiba/claude/work",
    );
  });
});

describe("usage-limit is a first-class verdict", () => {
  it("a usage-limit error event becomes ClaudeUsageLimitError with the reset hint", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Claude AI usage limit reached. Your limit resets at 9pm PT.",
    });
    try {
      claudeSubscriptionHarness.parseEvent(line);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeUsageLimitError);
      expect((error as ClaudeUsageLimitError).resetsAt).toMatch(/9pm/);
      expect((error as Error).message).toContain("usage limit reached");
    }
  });

  it("non-quota errors still surface as ClaudeCodeErrorEvent", () => {
    const line = JSON.stringify({ type: "result", is_error: true, result: "model blew up" });
    expect(() => claudeSubscriptionHarness.parseEvent(line)).toThrow(ClaudeCodeErrorEvent);
    expect(() => claudeSubscriptionHarness.parseEvent(line)).not.toThrow(ClaudeUsageLimitError);
  });
});

describe("admission gate (T47 controller)", () => {
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

  const kvEnv = () => ({ AGENT_TOKENS: new FakeKV() as unknown as KVNamespace });

  it("refuses a run whose flow never succeeded; accepts a succeeded one", async () => {
    const env = kvEnv();
    await expect(
      assertHarnessAuthorized(env, claudeSubscriptionHarness, input()),
    ).rejects.toThrow(/no authenticated account/);
    // Operator drives the flow end-to-end on the same env: begin → verify.
    // The probe hits forwardClaudeSubscription; stub the wire to a 200.
    const { claudeSubscriptionAuth } = await import("../src/auth/claude-subscription.js");
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const secretEnv = { ...env, CLAUDE_SUBSCRIPTION_TOKEN: "sk-ant-oat01-real" };
      const controller = claudeSubscriptionAuth(secretEnv, "claude-sub:default");
      await controller.begin("owner@example.com");
      await controller.verify("owner@example.com");
    } finally {
      globalThis.fetch = original;
    }
    await expect(
      assertHarnessAuthorized(env, claudeSubscriptionHarness, input()),
    ).resolves.toBeUndefined();
  });

  it("a cleared flow refuses the next run — admission closes on sign-out", async () => {
    const env = kvEnv();
    const secretEnv = { ...env, CLAUDE_SUBSCRIPTION_TOKEN: "sk-ant-oat01-real" };
    const { claudeSubscriptionAuth } = await import("../src/auth/claude-subscription.js");
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const controller = claudeSubscriptionAuth(secretEnv, "claude-sub:default");
      await controller.begin("owner@example.com");
      await controller.verify("owner@example.com");
      await controller.clear("owner@example.com");
    } finally {
      globalThis.fetch = original;
    }
    await expect(
      assertHarnessAuthorized(env, claudeSubscriptionHarness, input()),
    ).rejects.toThrow(/no authenticated account/);
  });

  it("harnesses without an auth requirement pass untouched", async () => {
    const { resolveHarness } = await import("../src/harness/index.js");
    await expect(
      assertHarnessAuthorized(kvEnv(), resolveHarness("opencode"), input()),
    ).resolves.toBeUndefined();
  });
});

describe("resume-same-key is a decider rule", () => {
  const queueInput = (extra: Partial<QueuedRunInput> = {}): QueuedRunInput => ({
    sandboxId: "run-abcdef12345678",
    repoUrl: "https://github.com/acme/widgets",
    task: "Fix it.",
    baseBranch: "main",
    publishPullRequest: false,
    continuationKey: "claude:home:/root/.shiba/claude/default",
    ...extra,
  });

  it("a resume claiming a different key is refused input_conflict", () => {
    const decision = decideRunTransition(
      { run: null },
      {
        type: "queue",
        commandId: "cmd-1",
        runId: "run-1",
        input: queueInput({ continuesKey: "claude:home:/root/.shiba/claude/work" }),
        at: 1,
      },
    );
    expect(decision).toMatchObject({ error: { code: "input_conflict" } });
    expect("error" in decision && decision.error.message).toContain("cannot resume");
  });

  it("a matching continuesKey queues and persists the key on the record", () => {
    const decision = decideRunTransition(
      { run: null },
      {
        type: "queue",
        commandId: "cmd-2",
        runId: "run-2",
        input: queueInput({ continuesKey: "claude:home:/root/.shiba/claude/default" }),
        at: 1,
      },
    );
    expect("events" in decision && decision.events[0]?.type).toBe("run.queued");
    const run = "events" in decision ? (decision.events[0] as { run: DelegatedRun }).run : null;
    expect(run?.continuationKey).toBe("claude:home:/root/.shiba/claude/default");
  });
});
