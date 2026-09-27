/**
 * T49 — `codex-subscription` harness (PLAN.md §18.11). Codex's credential is
 * directory-shaped, so the test plan differs from T48's token-in-env proof:
 *   1. opt-in: absent SHIBA_CODEX_SUBSCRIPTION the harness is unregistered,
 *      uncataloged, unselectable;
 *   2. the two-level CODEX_HOME: a shared home holds the verbatim known-
 *      shared list; per-account shadows overlay auth.json via symlinks and
 *      keep log/memories/tmp local — continuation key (shared) ≠ account
 *      key (effective home);
 *   3. private-entry refusal: a symlinked auth.json in a shadow is a
 *      containment breach, not a misconfiguration;
 *   4. the real credential never enters the container — stub auth.json in
 *      the shadow, the Worker-side secret materializes into egress headers.
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
import {
  decideRunTransition,
  resolveCodexSubscriptionHome,
  codexShadowHomeOps,
  assertCodexPrivateEntriesReal,
  codexUpdateHomePath,
  isCodexPrivateEntry,
  isCodexShadowLocalEntry,
  CodexHomePrivateEntrySymlinkError,
  CODEX_KNOWN_SHARED_DIRECTORIES,
  CODEX_PRIVATE_ENTRY_NAMES,
  CODEX_SHADOW_LOCAL_ENTRY_NAMES,
  type DelegatedRun,
  type QueuedRunInput,
} from "@shiba/shared";
import { agentCliCatalog } from "../src/harness/catalog.js";
import {
  codexSubscriptionHarness,
  codexSubscriptionHome,
  codexSubscriptionHomeDir,
  codexSubscriptionInstanceId,
  codexSubscriptionAccountFromInstanceId,
  CodexUsageLimitError,
  CODEX_SUBSCRIPTION_HOSTS,
  CODEX_SUBSCRIPTION_PLACEHOLDER,
  CODEX_SUBSCRIPTION_SHARED_HOME,
} from "../src/harness/codex-subscription.js";
import { CodexErrorEvent } from "../src/harness/codex.js";
import { resolveHarness, SANDBOX_HARNESS_NAMES, sandboxHarnessNames } from "../src/harness/index.js";
import { forwardCodexSubscription, GATEWAY_PROVIDERS, parseCodexAuthJson, type EgressEnv } from "../src/egress.js";
import { assertHarnessAuthorized } from "../src/auth/index.js";
import { codexSubscriptionSecretName } from "@shiba/auth";
import { Sandbox } from "../src/sandbox.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const ENABLED = { SHIBA_CODEX_SUBSCRIPTION: "1" };
const SUB_MODEL = "openai-subscription/gpt-5.3-codex";
const STORED_AUTH_JSON = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id-tok",
    access_token: "chatgpt-access-token",
    refresh_token: "chatgpt-refresh-token",
    account_id: "acct-123",
  },
  last_refresh: 1,
});

const input = (extra: Partial<CodingTaskInput> = {}): CodingTaskInput => ({
  repoUrl: "https://github.com/acme/widgets",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: SUB_MODEL,
  ...extra,
});

describe("opt-in gate (§18.11 constraints)", () => {
  it("is unregistered without the flag — not selectable, not listed", () => {
    expect(() => resolveHarness("codex-subscription")).toThrow(/Unknown agent harness/);
    expect(() => resolveHarness("codex-subscription", { SHIBA_CODEX_SUBSCRIPTION: "0" })).toThrow(
      /Unknown agent harness/,
    );
    expect(SANDBOX_HARNESS_NAMES).not.toContain("codex-subscription");
    expect(agentCliCatalog({}).map((a) => a.id)).not.toContain("codex-subscription");
    // A distinct var: enabling claude does not enable codex.
    expect(() => resolveHarness("codex-subscription", { SHIBA_CLAUDE_SUBSCRIPTION: "1" })).toThrow(
      /Unknown agent harness/,
    );
  });

  it("SHIBA_CODEX_SUBSCRIPTION=1 registers it everywhere it should appear", () => {
    expect(resolveHarness("codex-subscription", ENABLED).name).toBe("codex-subscription");
    expect(sandboxHarnessNames(ENABLED)).toContain("codex-subscription");
    const entry = agentCliCatalog({ ...ENABLED }).find((a) => a.id === "codex-subscription");
    expect(entry).toBeDefined();
    expect(entry?.credential?.label).toBe("CODEX_SUBSCRIPTION_AUTH_JSON");
    expect(entry?.credential?.configured).toBe(false);
    expect(entry?.credential?.setupHint).toContain("codex login");
    const configured = agentCliCatalog({ ...ENABLED, CODEX_SUBSCRIPTION_AUTH_JSON: STORED_AUTH_JSON }).find(
      (a) => a.id === "codex-subscription",
    );
    expect(configured?.credential?.configured).toBe(true);
  });
});

describe("two-level CODEX_HOME (the §18.11 port)", () => {
  it("default account is direct mode — no overlay, shared home is effective", () => {
    const layout = resolveCodexSubscriptionHome({ sharedHomePath: CODEX_SUBSCRIPTION_SHARED_HOME });
    expect(layout.mode).toBe("direct");
    expect(layout.effectiveHomePath).toBeUndefined();
    expect(layout.accountKey).toBe(`codex:account:${CODEX_SUBSCRIPTION_SHARED_HOME}`);
    expect(layout.continuationKey).toBe(`codex:home:${CODEX_SUBSCRIPTION_SHARED_HOME}`);
    expect(codexSubscriptionHomeDir(input())).toBe(CODEX_SUBSCRIPTION_SHARED_HOME);
  });

  it("a named account gets a shadow; continuation key stays shared, account key is the overlay", () => {
    const layout = codexSubscriptionHome(input({ authAccount: "work" }));
    expect(layout.mode).toBe("authOverlay");
    expect(layout.sharedHomePath).toBe(CODEX_SUBSCRIPTION_SHARED_HOME);
    expect(layout.effectiveHomePath).toBe("/root/.shiba/codex/acc-work");
    // The §18.11 invariant: continuation key ≠ account key.
    expect(layout.continuationKey).toBe(`codex:home:${CODEX_SUBSCRIPTION_SHARED_HOME}`);
    expect(layout.accountKey).toBe(`codex:account:${layout.effectiveHomePath}`);
    expect(layout.continuationKey).not.toBe(layout.accountKey);
  });

  it("two accounts share one continuation key — a resume on the same thread swaps accounts cleanly", () => {
    const work = codexSubscriptionHome(input({ authAccount: "work" }));
    const ops = codexSubscriptionHome(input({ authAccount: "ops" }));
    expect(work.continuationKey).toBe(ops.continuationKey);
    expect(work.accountKey).not.toBe(ops.accountKey);
    const workDir = work.effectiveHomePath!;
    const opsDir = ops.effectiveHomePath!;
    expect(codexSubscriptionInstanceId(input({ authAccount: "work" }))).toBe(`codex-sub:${workDir}`);
    expect(codexSubscriptionInstanceId(input({ authAccount: "ops" }))).toBe(`codex-sub:${opsDir}`);
    expect(codexSubscriptionAccountFromInstanceId(`codex-sub:${workDir}`)).toBe("work");
    expect(codexSubscriptionAccountFromInstanceId(`codex-sub:${CODEX_SUBSCRIPTION_SHARED_HOME}`)).toBe("default");
  });

  it("materialization ops: shared dirs + shadow-locals are mkdirs; non-private entries are symlinks", () => {
    const layout = codexSubscriptionHome(input({ authAccount: "work" }));
    const ops = codexShadowHomeOps(layout, []);
    const mkdirs = ops.filter((o) => o.op === "mkdir").map((o) => o.path);
    const links = ops.filter((o) => o.op === "symlink");
    // Every known-shared directory is created under the shared home.
    for (const dir of CODEX_KNOWN_SHARED_DIRECTORIES) {
      expect(mkdirs).toContain(`${CODEX_SUBSCRIPTION_SHARED_HOME}/${dir}`);
    }
    // The shadow dir and its shadow-local entries are real directories.
    expect(mkdirs).toContain(layout.effectiveHomePath);
    for (const name of CODEX_SHADOW_LOCAL_ENTRY_NAMES) {
      expect(mkdirs).toContain(`${layout.effectiveHomePath}/${name}`);
    }
    // Known-shared directories are linked INTO the shadow…
    const linked = new Set(links.map((l) => l.link));
    for (const dir of CODEX_KNOWN_SHARED_DIRECTORIES) {
      expect(linked).toContain(`${layout.effectiveHomePath}/${dir}`);
    }
    // …except private entries (a symlinked auth.json is the breach the
    // refusal guards) and shadow-local entries (they must stay per-shadow).
    const linkedNames = new Set(links.map((l) => l.link.split("/").pop()));
    for (const name of [...CODEX_PRIVATE_ENTRY_NAMES, ...CODEX_SHADOW_LOCAL_ENTRY_NAMES]) {
      expect(linkedNames.has(name)).toBe(false);
    }
    // The commands never carry token material.
    expect(JSON.stringify(ops)).not.toContain("chatgpt-access-token");
  });

  it("assertCodexPrivateEntriesReal refuses a symlinked auth.json — the §18.11 breach", () => {
    const layout = codexSubscriptionHome(input({ authAccount: "work" }));
    expect(() => assertCodexPrivateEntriesReal(layout, { "auth.json": "symlink" })).toThrow(
      CodexHomePrivateEntrySymlinkError,
    );
    expect(() => assertCodexPrivateEntriesReal(layout, { "models_cache.json": "symlink" })).toThrow(
      CodexHomePrivateEntrySymlinkError,
    );
    expect(() =>
      assertCodexPrivateEntriesReal(layout, { "auth.json": "file", "models_cache.json": "missing" }),
    ).not.toThrow();
    expect(isCodexPrivateEntry("auth.json")).toBe(true);
    expect(isCodexShadowLocalEntry("tmp")).toBe(true);
  });

  it("codex updates run against the shared home — the overlay has no install", () => {
    expect(codexUpdateHomePath(codexSubscriptionHome(input({ authAccount: "work" })))).toBe(
      CODEX_SUBSCRIPTION_SHARED_HOME,
    );
  });
});

describe("the credential never enters the container", () => {
  it("env() carries CODEX_HOME and no OpenAI key material at all", () => {
    const env = codexSubscriptionHarness.env(input({ authAccount: "work" }));
    expect(env.CODEX_HOME).toBe("/root/.shiba/codex/acc-work");
    for (const [key, value] of Object.entries(env)) {
      expect(key).not.toContain("API_KEY");
      expect(key).not.toContain("TOKEN");
      expect(value).not.toContain("chatgpt-access-token");
    }
  });

  it("configFile is a stub auth.json + preferred_auth_method config, both inside the shadow", () => {
    const files = codexSubscriptionHarness.configFile(input({ authAccount: "work" }));
    expect(Array.isArray(files)).toBe(true);
    const list = files as { path: string; contents: string }[];
    expect(list.map((f) => f.path).sort()).toEqual([
      "/root/.shiba/codex/acc-work/auth.json",
      "/root/.shiba/codex/acc-work/config.toml",
    ]);
    const auth = list.find((f) => f.path.endsWith("auth.json"))!;
    const parsed = JSON.parse(auth.contents) as { tokens: { access_token: string } };
    expect(parsed.tokens.access_token).toContain(CODEX_SUBSCRIPTION_PLACEHOLDER);
    expect(auth.contents).not.toContain("chatgpt-access-token");
    expect(list.find((f) => f.path.endsWith("config.toml"))!.contents).toContain('preferred_auth_method = "chatgpt"');
  });
});

describe("egress isolation — own branch, deny-by-default", () => {
  it("chatgpt.com is NOT a gateway provider — the subscription rides an override branch", () => {
    expect(GATEWAY_PROVIDERS["chatgpt.com"]).toBeUndefined();
    expect(Sandbox.outboundHandlers?.codexSubscription).toBe(forwardCodexSubscription);
  });

  it("egressOverrides pins chatgpt.com to the dedicated handler with the account name", () => {
    const overrides = codexSubscriptionHarness.egressOverrides!(input({ authAccount: "ops" }));
    expect(overrides.map((o) => o.host)).toEqual([...CODEX_SUBSCRIPTION_HOSTS]);
    for (const o of overrides) {
      expect(o.handler).toBe("codexSubscription");
      expect(o.params).toEqual({ account: "ops" });
      expect(JSON.stringify(o.params)).not.toContain("chatgpt-access-token");
    }
  });

  it("egressHosts is the ChatGPT backend set; the openai provider namespace is rejected", () => {
    expect(codexSubscriptionHarness.egressHosts(SUB_MODEL)).toEqual(["chatgpt.com"]);
    expect(() => codexSubscriptionHarness.egressHosts("openai/gpt-5.3-codex")).toThrow(/Unsupported coding model/);
  });

  it("forwarder refuses non-chatgpt hosts and non-GET/POST, 503s on missing or malformed secret", async () => {
    const env = { CODEX_SUBSCRIPTION_AUTH_JSON: STORED_AUTH_JSON } as unknown as EgressEnv;
    expect((await forwardCodexSubscription(new Request("https://api.openai.com/v1/x"), env)).status).toBe(403);
    expect(
      (await forwardCodexSubscription(new Request("https://chatgpt.com/backend-api/codex/responses", { method: "DELETE" }), env)).status,
    ).toBe(405);
    expect(
      (await forwardCodexSubscription(new Request("https://chatgpt.com/backend-api/wham/usage"), {} as unknown as EgressEnv)).status,
    ).toBe(503);
    expect(
      (
        await forwardCodexSubscription(
          new Request("https://chatgpt.com/backend-api/wham/usage"),
          { CODEX_SUBSCRIPTION_AUTH_JSON: "not json" } as unknown as EgressEnv,
        )
      ).status,
    ).toBe(503);
  });

  it("forwarder materializes Bearer + chatgpt-account-id from the stored auth.json", async () => {
    const seen: { auth?: string | null; account?: string | null; url?: string } = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (req: RequestInfo | URL, init?: RequestInit) => {
      seen.url = req instanceof Request ? req.url : String(req);
      const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as HeadersInit);
      seen.auth = headers.get("authorization");
      seen.account = headers.get("chatgpt-account-id");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const env = { CODEX_SUBSCRIPTION_AUTH_JSON_OPS: STORED_AUTH_JSON } as unknown as EgressEnv;
      const response = await forwardCodexSubscription(
        new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" }),
        env,
        { params: { account: "ops" } },
      );
      expect(response.status).toBe(200);
      expect(seen.auth).toBe("Bearer chatgpt-access-token");
      expect(seen.account).toBe("acct-123");
      expect(seen.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("parseCodexAuthJson accepts a verbatim auth.json, rejects malformed ones", () => {
    expect(parseCodexAuthJson(STORED_AUTH_JSON)).toEqual({ accessToken: "chatgpt-access-token", accountId: "acct-123" });
    expect(parseCodexAuthJson("{}")).toBeNull();
    expect(parseCodexAuthJson('{"tokens":{}}')).toBeNull();
    expect(parseCodexAuthJson("not json")).toBeNull();
    expect(codexSubscriptionSecretName("default")).toBe("CODEX_SUBSCRIPTION_AUTH_JSON");
    expect(codexSubscriptionSecretName("work-acct")).toBe("CODEX_SUBSCRIPTION_AUTH_JSON_WORK_ACCT");
  });
});

describe("harness shape", () => {
  it("buildArgv is codex exec with the provider prefix stripped", () => {
    const argv = codexSubscriptionHarness.buildArgv(input(), "/workspace/run-1");
    expect(argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(argv).toContain("gpt-5.3-codex");
    expect(argv[argv.length - 1]).toBe("Fix it.");
    expect(argv.join(" ")).not.toContain("openai-subscription");
  });

  it("setupCommands are the layout ops on the mkdir/ln allowlist shape", () => {
    const commands = codexSubscriptionHarness.setupCommands!(input({ authAccount: "work" }));
    expect(commands.length).toBeGreaterThan(0);
    for (const argv of commands) {
      expect(["mkdir", "ln"]).toContain(argv[0]);
    }
  });

  it("auth instanceId keys on the auth.json-holding directory", () => {
    expect(codexSubscriptionHarness.auth?.instanceId(input())).toBe(`codex-sub:${CODEX_SUBSCRIPTION_SHARED_HOME}`);
    expect(codexSubscriptionHarness.auth?.instanceId(input({ authAccount: "work" }))).toBe(
      "codex-sub:/root/.shiba/codex/acc-work",
    );
  });
});

describe("usage-limit is a first-class verdict", () => {
  it("a quota error becomes CodexUsageLimitError, not a bare failure", () => {
    const line = JSON.stringify({ type: "error", message: "You have hit your usage limit for this account." });
    try {
      codexSubscriptionHarness.parseEvent(line);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexUsageLimitError);
      expect((error as Error).message).toContain("usage limit");
    }
  });

  it("non-quota errors still surface as CodexErrorEvent", () => {
    const line = JSON.stringify({ type: "error", message: "model blew up" });
    expect(() => codexSubscriptionHarness.parseEvent(line)).toThrow(CodexErrorEvent);
    expect(() => codexSubscriptionHarness.parseEvent(line)).not.toThrow(CodexUsageLimitError);
  });
});

describe("admission gate (T47 controller, account-keyed)", () => {
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
    await expect(assertHarnessAuthorized(env, codexSubscriptionHarness, input())).rejects.toThrow(
      /no authenticated account/,
    );
    const { codexSubscriptionAuth } = await import("@shiba/auth");
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const secretEnv = { ...env, CODEX_SUBSCRIPTION_AUTH_JSON: STORED_AUTH_JSON };
      const controller = codexSubscriptionAuth(secretEnv, codexSubscriptionInstanceId(input()), (r, e, c) =>
        forwardCodexSubscription(r, e as EgressEnv, c),
      );
      await controller.begin("owner@example.com");
      await controller.verify("owner@example.com");
    } finally {
      globalThis.fetch = original;
    }
    await expect(assertHarnessAuthorized(env, codexSubscriptionHarness, input())).resolves.toBeUndefined();
  });

  it("clearing an overlay refuses that account only — the shared account is untouched", async () => {
    const env = kvEnv();
    const { codexSubscriptionAuth } = await import("@shiba/auth");
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const secretEnv = {
        ...env,
        CODEX_SUBSCRIPTION_AUTH_JSON: STORED_AUTH_JSON,
        CODEX_SUBSCRIPTION_AUTH_JSON_WORK: STORED_AUTH_JSON,
      };
      const shared = codexSubscriptionAuth(secretEnv, codexSubscriptionInstanceId(input()), (r, e, c) =>
        forwardCodexSubscription(r, e as EgressEnv, c),
      );
      const work = codexSubscriptionAuth(secretEnv, codexSubscriptionInstanceId(input({ authAccount: "work" })));
      await shared.begin("owner@example.com");
      await shared.verify("owner@example.com");
      await work.begin("owner@example.com");
      await work.verify("owner@example.com");
      await work.clear("owner@example.com");
    } finally {
      globalThis.fetch = original;
    }
    await expect(
      assertHarnessAuthorized(env, codexSubscriptionHarness, input({ authAccount: "work" })),
    ).rejects.toThrow(/no authenticated account/);
    await expect(assertHarnessAuthorized(env, codexSubscriptionHarness, input())).resolves.toBeUndefined();
  });
});

describe("resume-same-key is a decider rule", () => {
  const queueInput = (extra: Partial<QueuedRunInput> = {}): QueuedRunInput => ({
    sandboxId: "run-abcdef12345678",
    repoUrl: "https://github.com/acme/widgets",
    task: "Fix it.",
    baseBranch: "main",
    publishPullRequest: false,
    continuationKey: `codex:home:${CODEX_SUBSCRIPTION_SHARED_HOME}`,
    authAccount: "work",
    ...extra,
  });

  it("a resume claiming a different home is refused input_conflict", () => {
    const decision = decideRunTransition(
      { run: null },
      {
        type: "queue",
        commandId: "cmd-1",
        runId: "run-1",
        input: queueInput({ continuesKey: "codex:home:/root/.shiba/codex/other" }),
        at: 1,
      },
    );
    expect(decision).toMatchObject({ error: { code: "input_conflict" } });
  });

  it("a matching continuesKey queues and persists both keys on the record", () => {
    const decision = decideRunTransition(
      { run: null },
      {
        type: "queue",
        commandId: "cmd-2",
        runId: "run-2",
        input: queueInput({ continuesKey: `codex:home:${CODEX_SUBSCRIPTION_SHARED_HOME}` }),
        at: 1,
      },
    );
    expect("events" in decision && decision.events[0]?.type).toBe("run.queued");
    const run = "events" in decision ? (decision.events[0] as { run: DelegatedRun }).run : null;
    expect(run?.continuationKey).toBe(`codex:home:${CODEX_SUBSCRIPTION_SHARED_HOME}`);
    expect(run?.authAccount).toBe("work");
  });
});
