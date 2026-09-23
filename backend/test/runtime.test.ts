import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { Sandbox } from "../src/sandbox.js";

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  proxyToSandbox: vi.fn().mockResolvedValue(null),
  getSandbox: vi.fn(),
}));

vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

import { getAgentByName } from "agents/routing";
import { proxyToSandbox } from "@cloudflare/sandbox";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
import type { Env } from "../src/env.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import {
  COMPUTER_PREVIEW_MESSAGE,
  ComputerPreviewAdapter,
  MAX_FILE_CHARS,
  MAX_PROGRESS_EVENTS,
  SandboxRuntimeAdapter,
  buildOpencodeArgv,
  buildOpencodeConfig,
  createRuntimeAdapter,
  parsePorcelainStatus,
  resolveRuntimeName,
  type ProgressEvent,
  type SandboxOps,
  unescapePorcelainPath,
} from "../src/runtime.js";

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix it; rm -rf /",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

interface RecordedExec {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

function makeFakeOps(overrides: Partial<SandboxOps> = {}): SandboxOps & { execs: RecordedExec[] } {
  const execs: RecordedExec[] = [];
  return {
    execs,
    async gitCheckout() {},
    async writeFile() {},
    async exec(command, opts) {
      execs.push({ command, cwd: opts?.cwd, env: opts?.env });
      if (command.includes("opencode")) {
        return { stdout: "run output", stderr: "", exitCode: 0 };
      }
      if (command.includes("status")) {
        return { stdout: " M src/a.ts\n?? new.txt\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("diff")) {
        return { stdout: "diff --git a/src/a.ts", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return { kind: "utf8", content: "file content" };
    },
    ...overrides,
  };
}

describe("SandboxRuntimeAdapter", () => {
  it("clones, configures, runs, and collects changes", async () => {
    const ops = makeFakeOps();
    const seen: string[] = [];
    let checkoutArgs: { repoUrl: string; branch: string; targetDir: string } | null = null;
    ops.gitCheckout = async (repoUrl, opts) => {
      checkoutArgs = { repoUrl, branch: opts.branch, targetDir: `/x${opts.targetDir}`.slice(2) };
    };
    const events: ProgressEvent[] = [];
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, (event) => {
      events.push(event);
      seen.push(event.phase);
    });
    expect(checkoutArgs).toEqual({
      repoUrl: INPUT.repoUrl,
      branch: "main",
      targetDir: "/workspace/run-abcdef12345678",
    });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.changedFiles).toEqual(["src/a.ts", "new.txt"]);
    expect(result.diff).toContain("diff --git");
    expect(result.files).toHaveLength(2);
    expect(seen).toEqual(["clone", "configure", "code", "collect", "collect"]);
  });

  it("quotes the task so shell metacharacters cannot escape", async () => {
    const ops = makeFakeOps();
    const adapter = new SandboxRuntimeAdapter();
    await adapter.runCodingTask(ops, INPUT, () => {});
    const opencodeExec = ops.execs.find((exec) => exec.command.includes("opencode"));
    expect(opencodeExec).toBeDefined();
    // The hostile task must appear as one single-quoted word.
    expect(opencodeExec?.command).toContain(`'Fix it; rm -rf /'`);
    const taskWord = `'Fix it; rm -rf /'`;
    expect(execFileSync("sh", ["-c", `printf '%s' ${taskWord}`], { encoding: "utf8" })).toBe(
      "Fix it; rm -rf /",
    );
  });

  it("never passes real provider credentials into the container", async () => {
    const ops = makeFakeOps();
    const adapter = new SandboxRuntimeAdapter();
    await adapter.runCodingTask(ops, INPUT, () => {});
    const envText = JSON.stringify(ops.execs.map((exec) => exec.env));
    expect(envText).not.toContain("AI_GATEWAY_TOKEN");
    expect(envText).not.toContain("GITHUB_TOKEN");
    expect(envText).toContain("ai-intern-dummy-key");
  });

  it("reports clone failures honestly", async () => {
    const ops = makeFakeOps({
      async gitCheckout() {
        throw new Error("authentication required");
      },
    });
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Clone failed");
  });

  it("reports non-zero OpenCode exits with a bounded stderr tail", async () => {
    const ops = makeFakeOps({
      async exec() {
        return { stdout: "", stderr: `x\n${"e".repeat(50_000)}`, exitCode: 3 };
      },
    });
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail.length).toBeLessThan(20_000);
  });

  it("honors cancellation between phases", async () => {
    const ops = makeFakeOps();
    const adapter = new SandboxRuntimeAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.runCodingTask(ops, INPUT, () => {}, { signal: controller.signal })).rejects.toThrow(
      /cancelled/i,
    );
  });
});

describe("opencode config and argv", () => {
  it("builds an isolated google-provider config with a dummy key", () => {
    const config = buildOpencodeConfig(INPUT);
    expect(config).toMatchObject({
      model: "google/gemini-3.5-flash-lite",
      enabled_providers: ["google"],
      autoupdate: false,
    });
    const options = (config.provider as Record<string, { options: Record<string, string> }>)["google"];
    expect(options?.options.apiKey).toBe("ai-intern-dummy-key");
    expect(options?.options).not.toHaveProperty("baseURL");
  });

  it("accepts any provider the harness supports (T23 fixes B11)", () => {
    const config = buildOpencodeConfig({ ...INPUT, codingModel: "openai/gpt-5" });
    expect(config.enabled_providers).toEqual(["openai"]);
    expect((config.provider as Record<string, { options: { apiKey: string } }>).openai?.options.apiKey)
      .toBe("ai-intern-dummy-key");
  });

  it("refuses a provider the harness cannot drive, and a model with no provider", () => {
    expect(() => buildOpencodeConfig({ ...INPUT, codingModel: "mistral/large" }))
      .toThrow(/supports google, anthropic, openai/);
    expect(() => buildOpencodeConfig({ ...INPUT, codingModel: "gemini-3.5-flash-lite" }))
      .toThrow(/expected "provider\/model"/);
  });

  it("builds a headless JSON argv array", () => {
    expect(buildOpencodeArgv(INPUT, "/workspace/x")).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--model",
      "google/gemini-3.5-flash-lite",
      "--dir",
      "/workspace/x",
      INPUT.task,
    ]);
  });
});

describe("parsePorcelainStatus", () => {
  it("parses modifications, additions, and renames", () => {
    expect(parsePorcelainStatus(' M a.ts\nA  b.ts\nR  old.ts -> new.ts\n?? "sp ace.ts"\n')).toEqual([
      "a.ts",
      "b.ts",
      "new.ts",
      "sp ace.ts",
    ]);
  });

  it("drops unsafe paths but keeps legal names containing dots", () => {
    expect(parsePorcelainStatus(" M ../escape\n M /absolute\n M notes..txt\n")).toEqual(["notes..txt"]);
  });
});

describe("sandbox HTTPS egress", () => {
  const outboundCtx = { containerId: "test-container", className: "Sandbox" };
  function env(token?: string) {
    const getUrl = vi.fn().mockResolvedValue(
      "https://gateway.ai.cloudflare.com/v1/binding-account/default/google-ai-studio",
    );
    const gateway = vi.fn().mockReturnValue({ getUrl });
    return {
      AI: { gateway } as unknown as Env["AI"],
      GATEWAY_ID: "default",
      GITHUB_TOKEN: token,
      AI_GATEWAY_TOKEN: token,
      gateway,
      getUrl,
    };
  }

  it("rewrites native Google HTTPS egress using the binding and strips container credentials", async () => {
    const upstream = new Response("data: streamed reply\n\n");
    const fetchMock = vi.fn().mockResolvedValue(upstream);
    vi.stubGlobal("fetch", fetchMock);
    const bindings = env("worker-only-secret");
    const request = new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent?alt=sse&key=dummy&api_key=smuggled&apiKey=other",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer container-secret",
          "x-goog-api-key": "dummy",
          "x-api-key": "smuggled",
          "cf-aig-authorization": "Bearer container-gateway-token",
          "cf-aig-byok-alias": "container-chosen-key",
          "content-type": "application/json",
        },
        body: '{"contents":[]}',
      },
    );
    const response = await Sandbox.outboundByHost!["generativelanguage.googleapis.com"]!(request, bindings, outboundCtx);
    expect(response).toBe(upstream);
    expect(bindings.gateway).toHaveBeenCalledWith("default");
    expect(bindings.getUrl).toHaveBeenCalledWith("google-ai-studio");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://gateway.ai.cloudflare.com/v1/binding-account/default/google-ai-studio/v1beta/models/gemini:streamGenerateContent?alt=sse",
    );
    const headers = new Headers(init.headers);
    for (const name of ["authorization", "x-goog-api-key", "x-api-key", "cf-aig-byok-alias"]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(headers.get("cf-aig-authorization")).toBe("Bearer worker-only-secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe(request.body);
    expect(init.redirect).toBe("manual");
  });

  it("uses no provider credential when the gateway supplies BYOK", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await Sandbox.outboundByHost!["generativelanguage.googleapis.com"]!(
      new Request("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "cf-aig-authorization": "Bearer untrusted" },
      }),
      env(),
      outboundCtx,
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1].headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cf-aig-authorization")).toBe(false);
  });

  it.each([undefined, "github-worker-secret"])("authenticates GitHub only with a configured token (%s)", async (token) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("git advertisement"));
    vi.stubGlobal("fetch", fetchMock);
    // github.com is credentialed only through the per-run scoped handler (B6).
    await Sandbox.outboundHandlers!.githubScoped!(
      new Request("https://github.com/owner/repo.git/info/refs?service=git-upload-pack", {
        headers: { Authorization: "Bearer container-token" },
      }),
      env(token),
      { ...outboundCtx, params: { allowedPath: "/owner/repo" } } as never,
    );
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://github.com/owner/repo.git/info/refs?service=git-upload-pack");
    expect(new Headers(init.headers).get("authorization")).toBe(
      token ? `Basic ${btoa(`x-access-token:${token}`)}` : null,
    );
    expect(init.redirect).toBe("manual");
    expect(url.toString()).not.toContain("secret");
  });

  it("does not forward credentials to insecure or mismatched destinations", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const handler of Object.values(Sandbox.outboundByHost!)) {
      expect((await handler!(new Request("https://attacker.example/"), env("secret"), outboundCtx)).status).toBe(403);
      expect((await handler!(new Request("http://github.com/"), env("secret"), outboundCtx)).status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps authenticated fetch errors out of responses and logs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Authorization: worker-only-secret")));
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    // Both credentialed forwarders, each reached the way a real run reaches it.
    const attempts: [Request, Promise<Response>][] = [
      [
        new Request("https://generativelanguage.googleapis.com/"),
        Promise.resolve(Sandbox.outboundByHost!["generativelanguage.googleapis.com"]!(
          new Request("https://generativelanguage.googleapis.com/"),
          env("worker-only-secret"),
          outboundCtx,
        )),
      ],
      [
        new Request("https://github.com/owner/repo.git/info/refs"),
        Promise.resolve(Sandbox.outboundHandlers!.githubScoped!(
          new Request("https://github.com/owner/repo.git/info/refs"),
          env("worker-only-secret"),
          { ...outboundCtx, params: { allowedPath: "/owner/repo" } } as never,
        )),
      ],
    ];
    for (const [, pending] of attempts) {
      const response = await pending;
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("worker-only-secret");
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("sandbox egress allowlist (T5)", () => {
  // allowedHosts is an instance property on the base Container class, so
  // read it off an instance. The cast keeps tsc happy: the real DO
  // constructor takes (ctx, env), but under test the base is mocked.
  function sandboxHosts(): string[] | undefined {
    const Ctor = Sandbox as unknown as new () => { allowedHosts?: string[] };
    return new Ctor().allowedHosts;
  }

  it("deny-by-default allowlist contains both intercepted hosts plus codeload", () => {
    // PLAN.md §6 T5: allowedHosts is evaluated before outbound handlers.
    // Anything unlisted cannot leave the container, including from
    // repository code OpenCode runs.
    expect(sandboxHosts()).toEqual([
      "generativelanguage.googleapis.com",
      "github.com",
      "codeload.github.com", // git clone fetches packs here
    ]);
  });

  it("refuses a non-listed host", () => {
    expect(sandboxHosts()).not.toContain("attacker.example");
    // Deliberately shipped without npm registry: enabling `npm install`
    // inside runs is the widest exfiltration channel on the list (T5).
    expect(sandboxHosts()).not.toContain("registry.npmjs.org");
  });
});

describe("streamed opencode progress", () => {
  it("emits bounded progress from streamed stdout JSON events", async () => {
    const ops = makeFakeOps();
    const events: string[] = [];
    ops.exec = async (command, opts) => {
      for (const line of [
        JSON.stringify({ type: "step-start", part: "reading src/a.ts" }),
        "not json at all",
        JSON.stringify({ type: "step-finish" }),
      ]) {
        opts?.onOutput?.("stdout", `${line}\n`);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, (event) => {
      if (event.phase === "code" && event.message.startsWith("[opencode]")) events.push(event.message);
    });
    expect(result.status).toBe("completed");
    expect(events.length).toBe(3);
    expect(events[0]).toContain("reading src/a.ts");
    expect(events[1]).toContain("malformed event line (redacted)");
    expect(events[2]).not.toContain("undefined");
  });

  it("surfaces an opencode error event instead of pretending success", async () => {
    const ops = makeFakeOps();
    ops.exec = async (_command, opts) => {
      opts?.onOutput?.("stdout", `${JSON.stringify({ type: "error", message: "quota exhausted" })}\n`);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("quota exhausted");
  });

  it("caps progress events so a chatty run cannot flood the stream", async () => {
    const ops = makeFakeOps();
    ops.exec = async (_command, opts) => {
      for (let i = 0; i < 5000; i += 1) {
        opts?.onOutput?.("stdout", `${JSON.stringify({ type: "log", part: `line ${i}` })}\n`);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const events: ProgressEvent[] = [];
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, (event) => { events.push(event); });
    expect(result.status).toBe("completed");
    // "Running OpenCode headlessly." is one code-phase emit; streamed output is capped separately.
    const streamedCodeEvents = events.filter((event) => event.phase === "code" && event.message.startsWith("[opencode]"));
    expect(streamedCodeEvents.length).toBe(MAX_PROGRESS_EVENTS);
  });

  it("redacts secrets from the stderr tail", async () => {
    const ops = makeFakeOps({
      async exec() {
        return { stdout: "", stderr: "boom AI_GATEWAY_TOKEN=real-secret-value", exitCode: 0 };
      },
    });
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("completed");
    expect(result.stderrTail).not.toContain("real-secret-value");
  });
});

describe("complete file collection bounds", () => {
  it("passes per-file maxBytes and cancellation signal to readFile", async () => {
    const ops = makeFakeOps();
    const calls: Array<{ path: string; opts?: { maxBytes?: number; signal?: AbortSignal } }> = [];
    ops.readFile = async (path, opts) => {
      calls.push({ path, opts });
      return { kind: "utf8", content: "file content" };
    };
    const controller = new AbortController();
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, () => {}, { signal: controller.signal });
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.opts?.maxBytes).toBe(MAX_FILE_CHARS);
      expect(call.opts?.signal).toBe(controller.signal);
    }
  });

  it("fails the whole run when a file exceeds its bound instead of truncating", async () => {
    const ops = makeFakeOps({
      async readFile(_path, opts) {
        if ((opts?.maxBytes ?? 0) < 1_000_000) {
          throw new Error("readFile exceeded maxBytes: never truncating captured file content.");
        }
        return { kind: "utf8", content: "file content" };
      },
    });
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("maxBytes");
    expect(result.files).toHaveLength(0);
  });

  it("records deleted files as null content without reading them", async () => {
    const ops = makeFakeOps();
    const reads: string[] = [];
    ops.exec = async (command, opts) => {
      if (command.includes("opencode")) {
        opts?.onOutput?.("stdout", "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("status")) {
        return { stdout: " D src/deleted.ts\n M src/a.ts\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    ops.readFile = async (path) => {
      reads.push(path);
      return { kind: "utf8", content: "content" };
    };
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(ops, INPUT, () => {});
    expect(result.changedFiles).toEqual(["src/deleted.ts", "src/a.ts"]);
    expect(reads).toEqual(["/workspace/run-abcdef12345678/src/a.ts"]);
    expect(result.files).toEqual([
      { path: "src/a.ts", content: "content", encoding: "utf8" },
      { path: "src/deleted.ts", content: null, encoding: "utf8" },
    ]);
  });
});

describe("runtime seam", () => {
  it("defaults to sandbox and rejects unknown runtimes", () => {
    expect(resolveRuntimeName(undefined)).toBe("sandbox");
    expect(resolveRuntimeName("")).toBe("sandbox");
    expect(resolveRuntimeName("sandbox")).toBe("sandbox");
    expect(resolveRuntimeName("computer")).toBe("computer");
    expect(() => resolveRuntimeName("docker")).toThrow();
  });

  it("creates the sandbox adapter by default", async () => {
    const adapter = createRuntimeAdapter("sandbox");
    expect(adapter.name).toBe("sandbox");
    expect(adapter).toBeInstanceOf(SandboxRuntimeAdapter);
  });

  it("refuses computer runs with a preview message", async () => {
    const adapter = createRuntimeAdapter("computer");
    expect(adapter).toBeInstanceOf(ComputerPreviewAdapter);
    await expect(adapter.runCodingTask(makeFakeOps(), INPUT, () => {})).rejects.toThrow(
      COMPUTER_PREVIEW_MESSAGE,
    );
  });
});

describe("sandbox sleep tail (T11 — B9)", () => {
  it("sleeps after 1m to cut the idle compute tail", () => {
    // PLAN.md §7 T11: sleepAfter = "10m" + unique sandbox id per task means a
    // 5-minute task bills 15 container-minutes. "1m" cuts compute ~57%.
    expect(new Sandbox(null as any, null as any).sleepAfter).toBe("1m");
  });
});

describe("per-user orchestrator isolation", () => {
  function makeEnv() {
    return {
      CodingOrchestrator: {},
      Sandbox: {},
      ASSETS: { fetch: async () => new Response("assets") },
    } as unknown as Env;
  }

  it("routes requests to per-user orchestrator DO", async () => {
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    const stubFetch = vi.fn().mockResolvedValue(new Response("routed"));
    vi.mocked(getAgentByName).mockResolvedValue({ fetch: stubFetch } as never);
    const worker = (await import("../src/index.js")).default;
    const res = await worker.fetch(
      new Request("https://example.com/api/runs", {
        headers: { "CF-Access-Authenticated-User-Email": "alice@example.com" },
      }),
      makeEnv(),
    );
    expect(await res.text()).toBe("routed");
    expect(getAgentByName).toHaveBeenCalledWith({}, "alice@example.com");
    expect(stubFetch).toHaveBeenCalledOnce();
  });

  it("returns 401 without authenticated user email", async () => {
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    vi.mocked(getAgentByName).mockClear();
    const worker = (await import("../src/index.js")).default;
    const res = await worker.fetch(
      new Request("https://example.com/api/runs"),
      { ...makeEnv(), REQUIRE_ACCESS: "1" },
    );
    expect(res.status).toBe(401);
    expect(getAgentByName).not.toHaveBeenCalled();
  });
});

describe("worker authentication gate (T7)", () => {
  function makeAccessEnv(extra: Record<string, unknown> = {}) {
    return {
      CodingOrchestrator: {},
      Sandbox: {},
      ASSETS: { fetch: async () => new Response("assets") },
      REQUIRE_ACCESS: "1",
      ctx: { waitUntil: vi.fn() } as unknown as ExecutionContext,
      ...extra,
    } as unknown as Env & { ctx: ExecutionContext };
  }

  it("exposes SIGNATURE_AUTHENTICATED exemptions for slack and github webhook", async () => {
    const mod = await import("../src/index.js");
    expect(mod.SIGNATURE_AUTHENTICATED).toContain("/api/slack/events");
    expect(mod.SIGNATURE_AUTHENTICATED).toContain("/api/slack/command");
    expect(mod.SIGNATURE_AUTHENTICATED).toContain("/api/github/webhook");
    // Exact paths only: an unrelated sibling must not be exempt.
    expect(mod.SIGNATURE_AUTHENTICATED).not.toContain("/api/slack/");
  });

  it("isAuthenticated exempts signature-authenticated paths without an Access header", async () => {
    const mod = await import("../src/index.js");
    const env = makeAccessEnv();
    expect(mod.isAuthenticated(new Request("https://example.com/api/slack/events"), env)).toBe(true);
    expect(mod.isAuthenticated(new Request("https://example.com/api/slack/command"), env)).toBe(true);
    expect(mod.isAuthenticated(new Request("https://example.com/api/github/webhook"), env)).toBe(true);
    expect(mod.isAuthenticated(new Request("https://example.com/api/runs"), env)).toBe(false);
  });

  it("with REQUIRE_ACCESS, unauthenticated /api/runs → 401", async () => {
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    vi.mocked(getAgentByName).mockClear();
    const worker = (await import("../src/index.js")).default;
    const res = await worker.fetch(new Request("https://example.com/api/runs"), makeAccessEnv());
    expect(res.status).toBe(401);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("without REQUIRE_ACCESS, unauthenticated /api/runs succeeds (wrangler dev opt-out)", async () => {
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    const stubFetch = vi.fn().mockResolvedValue(new Response("routed"));
    vi.mocked(getAgentByName).mockResolvedValue({ fetch: stubFetch } as never);
    const worker = (await import("../src/index.js")).default;
    const res = await worker.fetch(
      new Request("https://example.com/api/runs"),
      {
        CodingOrchestrator: {},
        Sandbox: {},
        ASSETS: { fetch: async () => new Response("assets") },
      } as unknown as Env,
    );
    expect(res.status).not.toBe(401);
    expect(await res.text()).toBe("routed");
  });

  it("/api/slack/* is never gated by Access even without a header", async () => {
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    const worker = (await import("../src/index.js")).default;
    // No SLACK_SIGNING_SECRET → 503 proves the request reached the Slack
    // handler instead of being rejected 401 by the Access gate.
    const res = await worker.fetch(
      new Request("https://example.com/api/slack/command", { method: "POST" }),
      makeAccessEnv(),
    );
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(503);
  });

  it("POST /api/slack/interact reaches its handler without an Access header", async () => {
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    const worker = (await import("../src/index.js")).default;
    // No SLACK_SIGNING_SECRET -> 503 proves the mounted interact handler ran;
    // a 404 would mean the route never reaches it, 401 that the gate did.
    const res = await worker.fetch(
      new Request("https://example.com/api/slack/interact", { method: "POST" }),
      makeAccessEnv(),
    );
    expect(res.status).toBe(503);
  });

  it("/api/github/webhook is never gated by Access even without a header", async () => {
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    const worker = (await import("../src/index.js")).default;
    // No GITHUB_WEBHOOK_SECRET → 503 proves the request reached the webhook
    // handler instead of being rejected 401 by the Access gate.
    const res = await worker.fetch(
      new Request("https://example.com/api/github/webhook", { method: "POST" }),
      makeAccessEnv(),
    );
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(503);
  });

  it("gates routeAgentRequest without an Access header", async () => {
    const routing = await import("agents/routing");
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    vi.mocked(routing.routeAgentRequest).mockResolvedValue(new Response("agent"));
    const worker = (await import("../src/index.js")).default;
    const denied = await worker.fetch(new Request("https://example.com/agents/chat"), makeAccessEnv());
    expect(denied.status).toBe(401);
    // Only /agents/coding-orchestrator/<authenticated identity> reaches the DO.
    const allowed = await worker.fetch(
      new Request("https://example.com/agents/coding-orchestrator/alice%40example.com", {
        headers: { "CF-Access-Authenticated-User-Email": "alice@example.com" },
      }),
      makeAccessEnv(),
    );
    expect(await allowed.text()).toBe("agent");
    vi.mocked(routing.routeAgentRequest).mockResolvedValue(null);
  });

  it("gates asset fetch without an Access header", async () => {
    const routing = await import("agents/routing");
    vi.mocked(proxyToSandbox).mockResolvedValue(null);
    vi.mocked(routing.routeAgentRequest).mockResolvedValue(null);
    const worker = (await import("../src/index.js")).default;
    const denied = await worker.fetch(new Request("https://example.com/"), makeAccessEnv());
    expect(denied.status).toBe(401);
    const allowed = await worker.fetch(
      new Request("https://example.com/", {
        headers: { "CF-Access-Authenticated-User-Email": "alice@example.com" },
      }),
      makeAccessEnv(),
    );
    expect(await allowed.text()).toBe("assets");
  });
});

describe("unescapePorcelainPath", () => {
  it("decodes consecutive octal bytes as UTF-8, not Latin-1", () => {
    expect(unescapePorcelainPath('"caf\\303\\251.txt"')).toBe("caf\u00e9.txt");
    // Build the Japanese case from raw bytes: "\346" in a JS literal is
    // Latin-1, not the octal escape git actually quotes.
    const bytes = [..."\u65e5\u672c\u8a9e.md"].flatMap((c) => [...new TextEncoder().encode(c)]).map((b) => `\\${b.toString(8).padStart(3, "0")}`);
    expect(unescapePorcelainPath(`"${bytes.join("")}"`)).toBe("\u65e5\u672c\u8a9e.md");
  });
});
