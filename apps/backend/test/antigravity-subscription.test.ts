/**
 * T50 — `antigravity-subscription` (PLAN.md §18.12): the OAuth-in-container
 * subscription provider. The test plan ports the t3code checks the spec
 * calls "most likely to be got wrong":
 *   1. the callback ruleset verbatim — host/origin/path/state/code XOR
 *      error/iss — a pasted URL is refused for anything not the pending
 *      flow's listener;
 *   2. delivery is not authentication — a delivered callback leaves the
 *      flow `waiting`; only the capability probe sets `succeeded`;
 *   3. the pending record is owner-scoped and single-use;
 *   4. profile isolation — ambient Google credential keys are stripped,
 *      file storage is forced, profile dirs are 0700;
 *   5. opt-in gating — absent SHIBA_ANTIGRAVITY_SUBSCRIPTION the harness
 *      is unregistered; plain `antigravity` stays excluded.
 */
import { describe, expect, it, vi } from "vitest";

// @cloudflare/sandbox's containers sub-dep doesn't resolve under Node ESM;
// the provider statically imports getSandbox, so stub the package surface.
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  Container: class {},
  proxyToSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getContainer: vi.fn(),
}));

import {
  AntigravityCallbackError,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  ANTIGRAVITY_REMOVED_ENV_KEYS,
  antigravityBrowserCommand,
  antigravityEnvironment,
  antigravityProfilePaths,
  parseAntigravityAuthorizationUrl,
  validateAntigravityCallbackUrl,
  type AntigravityPendingCallback,
} from "@shiba/shared";
import { agentCliCatalog } from "../src/harness/catalog.js";
import {
  antigravitySubscriptionHarness,
  antigravitySubscriptionInstanceId,
  AntigravityUsageLimitError,
  ANTIGRAVITY_SUBSCRIPTION_HOSTS,
} from "../src/harness/antigravity-subscription.js";
import { resolveHarness, sandboxHarnessNames } from "../src/harness/index.js";
import { assertHarnessAuthorized } from "../src/auth/index.js";
import {
  antigravitySubscriptionAuth,
  type AntigravityAuthSandbox,
} from "../src/auth/antigravity-subscription.js";
import { AuthFlowError } from "../src/auth/controller.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const ENABLED = { SHIBA_ANTIGRAVITY_SUBSCRIPTION: "1" };
const SUB_MODEL = "google-subscription/gemini-3-pro";
const AUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8087%2F&state=s3cur3-state&client_id=x";
const PENDING: AntigravityPendingCallback = {
  redirectUri: "http://127.0.0.1:8087/",
  state: "s3cur3-state",
  sandboxId: "agy-auth-default",
};

const input = (extra: Partial<CodingTaskInput> = {}): CodingTaskInput => ({
  repoUrl: "https://github.com/acme/widgets",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: SUB_MODEL,
  ...extra,
});

describe("opt-in gate (§18.12 constraints)", () => {
  it("is unregistered without the flag — not selectable, not listed", () => {
    expect(() => resolveHarness("antigravity-subscription")).toThrow(/Unknown agent harness/);
    expect(() =>
      resolveHarness("antigravity-subscription", { SHIBA_ANTIGRAVITY_SUBSCRIPTION: "0" }),
    ).toThrow(/Unknown agent harness/);
    expect(sandboxHarnessNames(undefined)).not.toContain("antigravity-subscription");
    expect(agentCliCatalog({}).map((a) => a.id)).not.toContain("antigravity-subscription");
  });

  it("registers under SHIBA_ANTIGRAVITY_SUBSCRIPTION=1 and enters the sandbox list", () => {
    expect(resolveHarness("antigravity-subscription", ENABLED).name).toBe("antigravity-subscription");
    expect(sandboxHarnessNames(ENABLED)).toContain("antigravity-subscription");
    const row = agentCliCatalog(ENABLED).find((a) => a.id === "antigravity-subscription");
    expect(row?.credential.kind).toBe("oauth-signin");
    expect(row?.credential.configured).toBeNull();
  });

  it("plain antigravity stays excluded even when the flag is set", () => {
    expect(() => resolveHarness("antigravity", ENABLED)).toThrow(/not runnable in a sandbox/);
  });
});

describe("harness shape", () => {
  it("runs on the sandbox runtime and pins the google-subscription provider", () => {
    expect(antigravitySubscriptionHarness.capabilities().supportedRuntimes).toEqual(["sandbox"]);
    expect(antigravitySubscriptionHarness.supportedProviders).toEqual(["google-subscription"]);
    expect(antigravitySubscriptionHarness.egressHosts(SUB_MODEL)).toEqual([
      ...ANTIGRAVITY_SUBSCRIPTION_HOSTS,
    ]);
    expect(() =>
      antigravitySubscriptionHarness.egressHosts("google/gemini-3-pro"),
    ).toThrow(/supports google-subscription/);
  });

  it("instanceId keys on the account; continuation keys on the profile dir", () => {
    expect(antigravitySubscriptionInstanceId(input())).toBe("agy-sub:default");
    expect(antigravitySubscriptionInstanceId(input({ authAccount: "Team One" }))).toBe("agy-sub:team-one");
    expect(antigravitySubscriptionHarness.continuationKey(input({ authAccount: "acct1" }))).toBe(
      "agy:profile:/root/.shiba/antigravity/acct1",
    );
    expect(antigravitySubscriptionHarness.continuationKey(input())).toBe(
      "agy:profile:/root/.shiba/antigravity/default",
    );
  });

  it("configFile is the profile settings.json — auth.type oauth-personal, no credential", () => {
    const file = antigravitySubscriptionHarness.configFile(input());
    expect(file).not.toBeNull();
    const one = Array.isArray(file) ? file[0]! : file;
    expect(one.path).toBe("/root/.shiba/antigravity/default/antigravity-acp/settings.json");
    expect(JSON.parse(one.contents)).toEqual({ auth: { type: "oauth-personal" } });
    expect(one.contents).not.toContain("token");
  });

  it("setupCommands materialize the profile dirs and pin them to 0700", () => {
    const ops = antigravitySubscriptionHarness.setupCommands(input(), "/workspace/run-1");
    expect(ops).toEqual([
      ["mkdir", "-p", "/root/.shiba/antigravity/default/antigravity-acp", "/root/.shiba/antigravity/default/antigravity-acp/tmp"],
      ["chmod", "700", "/root/.shiba/antigravity/default", "/root/.shiba/antigravity/default/antigravity-acp"],
    ]);
  });

  it("env is the t3code launch env — file storage forced, ambient keys absent", () => {
    const env = antigravitySubscriptionHarness.env(input());
    expect(env.GEMINI_HOME).toBe("/root/.shiba/antigravity/default");
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    expect(env.PYTHONUNBUFFERED).toBe("1");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.BROWSER).toContain("-e ");
    // The removed list also contains the keys the launch env re-adds
    // (GEMINI_HOME, BROWSER, ...) — those are present by design; every
    // other removed key must stay absent.
    const reAdded = new Set(["GEMINI_HOME", "AGY_ACP_FORCE_FILE_STORAGE", "BROWSER", "PYTHONUNBUFFERED", "ELECTRON_RUN_AS_NODE"]);
    for (const key of ANTIGRAVITY_REMOVED_ENV_KEYS) {
      if (!reAdded.has(key)) expect(env[key]).toBeUndefined();
    }
    expect(Object.keys(env).some((k) => /API_KEY|CREDENTIALS|TOKEN/i.test(k))).toBe(false);
  });

  it("argv drives the pinned agy binary in the same one-shot shape as the stub", () => {
    expect(antigravitySubscriptionHarness.buildArgv(input(), "/w")).toEqual([
      "agy", "--no-interactive", "--yolo", "--model", "gemini-3-pro", "Fix it.",
    ]);
  });

  it("a usage-limit stream error is a first-class verdict", () => {
    const line = JSON.stringify({ type: "error", message: "usage limit reached" });
    expect(() => antigravitySubscriptionHarness.parseEvent(line)).toThrow(AntigravityUsageLimitError);
  });
});

describe("parseAntigravityAuthorizationUrl (t3code ruleset)", () => {
  it("accepts a well-formed accounts.google.com auth URL", () => {
    const parsed = parseAntigravityAuthorizationUrl(AUTH_URL);
    expect(parsed.redirectUri).toBe("http://127.0.0.1:8087/");
    expect(parsed.state).toBe("s3cur3-state");
  });

  it.each([
    "https://accounts.google.com/other?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8087%2F&state=s",
    "https://evil.example.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8087%2F&state=s",
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A80%2F&state=s",
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8087%2Fdir&state=s",
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=token&redirect_uri=http%3A%2F%2F127.0.0.1%3A8087%2F&state=s",
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8087%2F",
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=https%3A%2F%2F127.0.0.1%3A8087%2F&state=s",
    `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8087%2F&state=${"x".repeat(513)}`,
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => parseAntigravityAuthorizationUrl(url)).toThrow(AntigravityCallbackError);
  });
});

describe("validateAntigravityCallbackUrl (t3code ruleset)", () => {
  const good = "http://127.0.0.1:8087/?code=authcode123&state=s3cur3-state";

  it("accepts the pending flow's redirect with a code or an error", () => {
    expect(validateAntigravityCallbackUrl(PENDING, good).searchParams.get("code")).toBe("authcode123");
    expect(
      validateAntigravityCallbackUrl(PENDING, "http://127.0.0.1:8087/?error=access_denied&state=s3cur3-state")
        .searchParams.get("error"),
    ).toBe("access_denied");
  });

  it.each([
    "https://127.0.0.1:8087/?code=x&state=s3cur3-state", // https is not loopback-http
    "http://127.0.0.2:8087/?code=x&state=s3cur3-state", // only 127.0.0.1
    "http://localhost:8087/?code=x&state=s3cur3-state",
    "http://127.0.0.1:9999/?code=x&state=s3cur3-state", // wrong port = wrong origin
    "http://127.0.0.1:8087/other?code=x&state=s3cur3-state", // wrong path
    "http://127.0.0.1:8087/?code=x&state=other-state",
    "http://127.0.0.1:8087/?code=x", // missing state
    "http://127.0.0.1:8087/?code=x&state=s3cur3-state&state=s3cur3-state", // dup state
    "http://127.0.0.1:8087/?state=s3cur3-state", // no code and no error
    "http://127.0.0.1:8087/?code=x&error=y&state=s3cur3-state", // both
    "http://127.0.0.1:8087/?code=&state=s3cur3-state", // empty code
    "http://127.0.0.1:8087/?code=x&state=s3cur3-state&iss=https%3A%2F%2Fevil.example.com",
    "http://127.0.0.1:8087/?code=x&state=s3cur3-state#frag",
    "http://u:p@127.0.0.1:8087/?code=x&state=s3cur3-state",
    `http://127.0.0.1:8087/?code=x&state=s3cur3-state&${"a".repeat(17000)}`, // >16384
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => validateAntigravityCallbackUrl(PENDING, url)).toThrow(AntigravityCallbackError);
  });

  it("accepts iss=https://accounts.google.com when present", () => {
    expect(
      validateAntigravityCallbackUrl(
        PENDING,
        `${good}&iss=${encodeURIComponent("https://accounts.google.com")}`,
      ).searchParams.get("iss"),
    ).toBe("https://accounts.google.com");
  });
});

describe("profile env (t3code antigravityEnvironment)", () => {
  const paths = antigravityProfilePaths("/root/.shiba/antigravity/acct1");

  it("strips every ambient Google credential key (case-insensitive)", () => {
    const ambient: Record<string, string> = { PATH: "/bin", EDITOR: "vi" };
    for (const key of ANTIGRAVITY_REMOVED_ENV_KEYS) ambient[key] = "leak";
    ambient["gemini_api_key"] = "leak-lowercase"; // case-insensitive compare
    const env = antigravityEnvironment(paths, ambient, antigravityBrowserCommand());
    expect(env.PATH).toBe("/bin");
    expect(env.GEMINI_HOME).toBe(paths.geminiHome);
    for (const key of ANTIGRAVITY_REMOVED_ENV_KEYS) {
      if (key !== "GEMINI_HOME" && key !== "AGY_ACP_FORCE_FILE_STORAGE" && key !== "BROWSER" && key !== "PYTHONUNBUFFERED" && key !== "ELECTRON_RUN_AS_NODE") {
        expect(env[key]).toBeUndefined();
      }
    }
    expect(env.gemini_api_key).toBeUndefined();
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    expect(env.TMPDIR).toBe(paths.tempDirectory);
  });
});

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

/** A scriptable auth sandbox: queued exec results + a command log. */
class FakeSandbox implements AntigravityAuthSandbox {
  readonly commands: string[] = [];
  readonly files = new Map<string, string>();
  destroyed = false;
  private queue: { stdout: string; stderr: string; exitCode: number }[] = [];
  next(result: { stdout?: string; stderr?: string; exitCode?: number }): void {
    this.queue.push({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 });
  }
  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.commands.push(command);
    return this.queue.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

function makeFlow() {
  const kv = new FakeKV();
  const sandbox = new FakeSandbox();
  const env = {
    AGENT_TOKENS: kv as unknown as KVNamespace,
    Sandbox: {} as DurableObjectNamespace,
  };
  // begin: mkdir, chmod, then the detached spawn echo, then the log poll.
  sandbox.next({ exitCode: 0 }); // mkdir
  sandbox.next({ exitCode: 0 }); // chmod
  sandbox.next({ stdout: "started", exitCode: 0 }); // spawn
  sandbox.next({ stdout: `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${AUTH_URL}\n`, exitCode: 0 }); // log poll
  const deps = {
    sandboxFor: () => sandbox,
    pollAttempts: 2,
    pollIntervalMs: 0,
  };
  const controller = antigravitySubscriptionAuth(env, "agy-sub:default", deps);
  return { kv, sandbox, env, controller };
}

describe("T50 waiting flow — pending record + delivered callback (§18.12)", () => {
  it("begin parks on waiting with the authorization URL and pending record", async () => {
    const { controller, sandbox } = makeFlow();
    await controller.begin("sess-A");
    const snap = await controller.snapshot();
    expect(snap.phase).toBe("waiting");
    expect(snap.authorizationUrl).toBe(AUTH_URL);
    // The spawn carried the profile env — file storage forced, GEMINI_HOME set.
    const spawn = sandbox.commands.find((c) => c.includes("nohup agy"));
    expect(spawn).toContain("AGY_ACP_FORCE_FILE_STORAGE=\"1\"");
    expect(spawn).toContain('GEMINI_HOME="/root/.shiba/antigravity/default"');
    expect(sandbox.files.get("/root/.shiba/antigravity/default/antigravity-acp/settings.json")).toContain(
      "oauth-personal",
    );
  });

  it("a delivered callback stays waiting — only the probe sets succeeded", async () => {
    const { controller, sandbox } = makeFlow();
    await controller.begin("sess-A");
    sandbox.next({ stdout: "200", exitCode: 0 }); // the container listener answers 200
    const delivered = await controller.deliverCallback!(
      "sess-A",
      "http://127.0.0.1:8087/?code=code-1&state=s3cur3-state",
    );
    expect(delivered.message).toContain("delivered");
    // The curl was aimed at the pending listener inside the container.
    const curl = sandbox.commands.find((c) => c.includes("curl"));
    expect(curl).toContain("--noproxy");
    expect(curl).toContain("--max-time");
    expect(curl).toContain("127.0.0.1:8087");
    expect(curl).toContain("state=s3cur3-state");
    expect((await controller.snapshot()).phase).toBe("waiting");

    // Probe: token file present → succeeded. (test -s returns via queue)
    sandbox.next({ exitCode: 0 });
    expect((await controller.verify("sess-A")).phase).toBe("succeeded");
  });

  it("probe failure keeps the flow honest", async () => {
    const { controller, sandbox } = makeFlow();
    await controller.begin("sess-A");
    sandbox.next({ exitCode: 1 }); // token file absent
    const snap = await controller.verify("sess-A");
    expect(snap.phase).toBe("failed");
  });

  it("deliverCallback validates before sending — a stranger's URL never reaches the container", async () => {
    const { controller, sandbox } = makeFlow();
    await controller.begin("sess-A");
    const curlsBefore = sandbox.commands.filter((c) => c.includes("curl")).length;
    await expect(
      controller.deliverCallback!("sess-A", "http://127.0.0.1:8087/?code=x&state=WRONG"),
    ).rejects.toBeInstanceOf(AuthFlowError);
    expect((await controller.snapshot()).phase).toBe("failed");
    expect(sandbox.commands.filter((c) => c.includes("curl")).length).toBe(curlsBefore);
  });

  it("the paste is single-use and owner-scoped", async () => {
    const { controller, sandbox } = makeFlow();
    await controller.begin("sess-A");
    sandbox.next({ stdout: "200", exitCode: 0 });
    await controller.deliverCallback!("sess-A", "http://127.0.0.1:8087/?code=c&state=s3cur3-state");
    await expect(
      controller.deliverCallback!("sess-A", "http://127.0.0.1:8087/?code=c2&state=s3cur3-state"),
    ).rejects.toMatchObject({ reason: "invalid_phase" });
    await expect(
      controller.deliverCallback!("sess-B", "http://127.0.0.1:8087/?code=c3&state=s3cur3-state"),
    ).rejects.toMatchObject({ reason: "not_owner" });
  });

  it("deliverCallback refuses a non-waiting flow", async () => {
    const { env } = makeFlow();
    const idle = antigravitySubscriptionAuth(env, "agy-sub:other", { sandboxFor: () => new FakeSandbox() });
    await expect(
      idle.deliverCallback!("sess-A", "http://127.0.0.1:8087/?code=c&state=s"),
    ).rejects.toMatchObject({ reason: "invalid_phase" });
  });

  it("clear is idempotent and destroys the auth sandbox best-effort", async () => {
    const { controller, sandbox } = makeFlow();
    await controller.begin("sess-A");
    await controller.clear("sess-A");
    expect((await controller.snapshot()).phase).toBe("cleared");
    expect(sandbox.destroyed).toBe(true);
    await controller.clear("sess-A"); // idempotent
  });
});

describe("admission gate", () => {
  it("a run on this harness requires a succeeded flow for the account", async () => {
    const kv = new FakeKV();
    const env = {
      AGENT_TOKENS: kv as unknown as KVNamespace,
      Sandbox: {} as DurableObjectNamespace,
      ...ENABLED,
    };
    const harness = resolveHarness("antigravity-subscription", env);
    await expect(assertHarnessAuthorized(env, harness, input())).rejects.toThrow(/auth phase/);
    kv.map.set(
      "auth_flow_agy-sub:default",
      JSON.stringify({ phase: "succeeded", ownerSessionId: "sess-A" }),
    );
    await expect(assertHarnessAuthorized(env, harness, input())).resolves.toBeUndefined();
  });
});
