/**
 * T68: per-run env values never appear in a record, response or envelope in
 * the clear — only names, a digest, and a blob sealed to one orchestrator.
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyRunEvents,
  LOCAL_INTAKE_DASHBOARD,
  LOCAL_INTAKE_HEADER,
  LOCAL_RUNTIME_FLAG,
  parseRunEnv,
  runInputHash,
  type DelegatedRun,
} from "@shiba/shared";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { Env } from "../src/env.js";
import { opencodeHarness } from "../src/harness/opencode.js";
import type { CodingTaskResult } from "../src/opencode-input.js";
import { guardRunEnvLeak, openRunEnv, runEnvScrubber, sealRunEnv } from "../src/run-env-seal.js";
import { makeReceipt } from "../src/receipts.js";
import { handleRuns } from "../src/runs-routes.js";
import { LocalRuntimeAdapter, SandboxRuntimeAdapter, type LocalDispatchClient, type SandboxOps } from "../src/runtime.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => Response.json({ runs: [] }) }),
  routeAgentRequest: async () => null,
}));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/request-auth.js")>()),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => "devin",
}));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({
  createMcpHandler: () => ({ fetch: async () => Response.json({ mcp: "served" }), notify: {} }),
}));

const KEY = { MODEL_CREDENTIAL_KEY: "ab".repeat(32) };
const SECRET = "s3cr3t-value-7f2a";
const VARS = [{ name: "DATABASE_URL", value: SECRET }];

describe("parseRunEnv", () => {
  it("sorts by name and keeps values", () => {
    expect(parseRunEnv([{ name: "Z_KEY", value: "1" }, { name: "A_KEY", value: "2" }]).map((v) => v.name)).toEqual([
      "A_KEY",
      "Z_KEY",
    ]);
  });

  it.each([
    "PATH", "http_proxy", "GITHUB_TOKEN", "SHIBA_FLAG", "LD_PRELOAD", "NODE_EXTRA_CA_CERTS", "OPENAI_API_KEY",
    "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_OPTIONS", "BASH_ENV", "PYTHONPATH", "npm_config_registry", "XDG_CONFIG_HOME",
  ])("refuses the reserved name %s", (name) => {
    expect(() => parseRunEnv([{ name, value: "x" }])).toThrow(/reserved/);
  });

  it("keeps ordinary app variables like NODE_ENV usable", () => {
    expect(parseRunEnv([{ name: "NODE_ENV", value: "test" }])).toEqual([{ name: "NODE_ENV", value: "test" }]);
  });

  it("refuses bad names, oversize values, too many vars and too much in total", () => {
    expect(() => parseRunEnv([{ name: "1BAD", value: "x" }])).toThrow(/Invalid environment variable name/);
    expect(() => parseRunEnv([{ name: `N${"x".repeat(128)}`, value: "x" }])).toThrow(/Invalid environment variable name/);
    expect(() => parseRunEnv([{ name: "BIG", value: "x".repeat(8193) }])).toThrow(/at most 8192/);
    expect(() => parseRunEnv(Array.from({ length: 33 }, (_, i) => ({ name: `V${i}`, value: "x" })))).toThrow(/At most 32/);
    expect(() => parseRunEnv(Array.from({ length: 5 }, (_, i) => ({ name: `V${i}`, value: "x".repeat(8000) })))).toThrow(
      /total more than/,
    );
  });

  it("never echoes a value in an error", () => {
    expect(() => parseRunEnv([...VARS, ...VARS])).toThrow(expect.objectContaining({ message: expect.not.stringContaining(SECRET) }));
  });
});

describe("seal and open", () => {
  it("round-trips for the owner and digest it was sealed to", async () => {
    const sealed = await sealRunEnv(KEY, "alice", VARS);
    expect(sealed.names).toEqual(["DATABASE_URL"]);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(await openRunEnv(KEY, "alice", sealed.sealed, sealed.digest)).toEqual({ DATABASE_URL: SECRET });
  });

  it("refuses another owner, another digest, and a tampered blob", async () => {
    const sealed = await sealRunEnv(KEY, "alice", VARS);
    const other = (await sealRunEnv(KEY, "alice", [{ name: "DATABASE_URL", value: "other-value" }])).digest;
    await expect(openRunEnv(KEY, "mallory", sealed.sealed, sealed.digest)).rejects.toThrow(/do not belong/);
    await expect(openRunEnv(KEY, "alice", sealed.sealed, other)).rejects.toThrow(/do not belong/);
    await expect(openRunEnv(KEY, "alice", `${sealed.sealed.slice(0, -4)}AAAA`, sealed.digest)).rejects.toThrow(/do not belong/);
  });

  it("keys the digest, so a stored record can't confirm a guessed value", async () => {
    const plain = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ DATABASE_URL: SECRET })))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const alice = await sealRunEnv(KEY, "alice", VARS);
    expect(alice.digest).not.toBe(plain);
    expect((await sealRunEnv(KEY, "bob", VARS)).digest).not.toBe(alice.digest);
  });

  it("seals the largest payload the limits allow", async () => {
    const vars = Array.from({ length: 32 }, (_, i) => ({ name: `V${i}`, value: "x".repeat(1000) }));
    const sealed = await sealRunEnv(KEY, "alice", vars);
    expect(Object.keys(await openRunEnv(KEY, "alice", sealed.sealed, sealed.digest))).toHaveLength(32);
  });

  it("refuses without MODEL_CREDENTIAL_KEY", async () => {
    await expect(sealRunEnv({}, "alice", VARS)).rejects.toThrow(/MODEL_CREDENTIAL_KEY/);
  });
});

it("binds the env digest into the approval hash", () => {
  const base = { repoUrl: "https://github.com/o/r", task: "t", baseBranch: "main", publishPullRequest: false };
  expect(runInputHash({ ...base, envNames: ["A"], envDigest: "a".repeat(64) })).not.toBe(
    runInputHash({ ...base, envNames: ["A"], envDigest: "b".repeat(64) }),
  );
});

describe("/api/runs intake", () => {
  function makeOrchestrator(env: Record<string, unknown> = {}) {
    const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
      env: { ...productionEnvStubs(), ...KEY, ...env },
      name: "default",
      state: { runs: [] },
      setState(next: unknown) {
        setStateLikeProduction(this as unknown as CodingOrchestrator, next as Parameters<CodingOrchestrator["setState"]>[0]);
      },
      // Dispatch is fire-and-forget here; this suite asserts state, not the child run.
      keepAliveWhile: () => Promise.resolve(),
    });
    return instance as unknown as {
      onRequest: (request: Request) => Promise<Response>;
      state: { pendingApprovals?: { approvalId: string; envNames?: string[]; envDigest?: string; envSealed?: string }[] };
    };
  }
  const queue = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ repoUrl: "https://github.com/o/r", task: "fix the tests", ...body }),
    });

  it("freezes names, digest and the sealed blob — never the value", async () => {
    const orchestrator = makeOrchestrator();
    const environment = await sealRunEnv(KEY, "default", VARS);
    const res = await orchestrator.onRequest(queue({ environment }));
    expect(res.status).toBe(200);
    const approval = orchestrator.state.pendingApprovals?.[0];
    expect(approval?.envNames).toEqual(["DATABASE_URL"]);
    expect(approval?.envDigest).toBe(environment.digest);
    expect(JSON.stringify(orchestrator.state)).not.toContain(SECRET);
  });

  it("refuses a blob sealed for another orchestrator", async () => {
    const orchestrator = makeOrchestrator();
    const res = await orchestrator.onRequest(queue({ environment: await sealRunEnv(KEY, "someone-else", VARS) }));
    expect(res.status).toBe(400);
    expect(orchestrator.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("refuses env when the deployment default runtime is local", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1", RUNTIME: "local" });
    const res = await orchestrator.onRequest(queue({ environment: await sealRunEnv(KEY, "default", VARS) }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("local runtime");
  });

  it("hands the sealed blob to the minted run and keeps no copy on the decided approval", async () => {
    const orchestrator = makeOrchestrator();
    const queued = await orchestrator.onRequest(queue({ environment: await sealRunEnv(KEY, "default", VARS) }));
    const { approvalId } = (await queued.json()) as { approvalId: string };
    const approve = await orchestrator.onRequest(
      new Request("https://internal/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "owner" }),
      }),
    );
    expect(approve.status).toBe(200);
    const state = orchestrator.state as unknown as {
      pendingApprovals: { approvalId: string; envSealed?: string; envDigest?: string }[];
      runs: { runId: string; envSealed?: string }[];
    };
    const decided = state.pendingApprovals.find((a) => a.approvalId === approvalId);
    expect(decided?.envDigest).toBeDefined();
    expect(decided?.envSealed).toBeUndefined();
    expect(state.runs.find((r) => r.runId === `agent-tool:${approvalId}`)?.envSealed).toBeDefined();
  });

  it("refuses a composer effort the human picked but the server can't read, instead of dropping it", () => {
    const orchestrator = makeOrchestrator() as unknown as { messages: unknown[]; composerPin(): unknown };
    orchestrator.messages = [{ role: "user", metadata: { shibaTask: { reasoningEffort: "turbo" } } }];
    expect(() => orchestrator.composerPin()).toThrow(/Unknown reasoning effort/);
  });

  it("never lists the sealed blob", async () => {
    const orchestrator = makeOrchestrator();
    await orchestrator.onRequest(queue({ environment: await sealRunEnv(KEY, "default", VARS) }));
    const listing = await (await orchestrator.onRequest(new Request("https://internal/api/approvals"))).text();
    expect(listing).toContain("DATABASE_URL");
    expect(listing).not.toContain("envSealed");
  });

  it("refuses env on the local runtime", async () => {
    const orchestrator = makeOrchestrator({ [LOCAL_RUNTIME_FLAG]: "1" });
    const res = await orchestrator.onRequest(
      queue(
        { runtime: "local", harness: "opencode", environment: await sealRunEnv(KEY, "default", VARS) },
        { [LOCAL_INTAKE_HEADER]: LOCAL_INTAKE_DASHBOARD },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("local runtime");
  });
});

describe("runtime", () => {
  const INPUT = {
    repoUrl: "https://github.com/owner/repo",
    task: "t",
    baseBranch: "main",
    publishPullRequest: false,
    sandboxId: "run-abc",
    codingModel: "google/gemini-3.5-flash-lite",
  };

  it("passes approved env to the harness process, harness keys winning", async () => {
    const calls: { command: string; env?: Record<string, string> }[] = [];
    const ops = {
      async gitCheckout() {},
      async writeFile() {},
      async exec(command: string, opts?: { env?: Record<string, string> }) {
        calls.push({ command, env: opts?.env });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return { kind: "utf8", content: "" };
      },
    } as unknown as SandboxOps;
    const result = await new SandboxRuntimeAdapter(opencodeHarness).runCodingTask(ops, INPUT, () => {}, {
      env: { DATABASE_URL: SECRET, OPENCODE_CONFIG: "/evil.json" },
    });
    const harnessCall = calls.find((call) => call.command.includes("opencode"));
    expect(harnessCall, `${result.summary} | ${calls.map((c) => c.command.slice(0, 40)).join(" ; ")}`).toBeDefined();
    expect(harnessCall?.env?.DATABASE_URL).toBe(SECRET);
    expect(harnessCall?.env?.OPENCODE_CONFIG).not.toBe("/evil.json");
  });

  it("scrubs sandbox output before truncating it, so a cut can't leave part of a value", async () => {
    const ops = {
      async gitCheckout() {},
      async writeFile() {},
      async exec(command: string) {
        // The tail window starts 9 chars into the secret — truncating first would leave "lue-7f2a".
        if (command.includes("opencode")) return { stdout: "", stderr: SECRET + "y".repeat(7992), exitCode: 1 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return { kind: "utf8", content: "" };
      },
    } as unknown as SandboxOps;
    const result = await new SandboxRuntimeAdapter(opencodeHarness).runCodingTask(ops, INPUT, () => {}, {
      env: { DATABASE_URL: SECRET },
      scrub: runEnvScrubber({ DATABASE_URL: SECRET }),
    });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain(SECRET.slice(9));
  });

  it("the local adapter refuses env", async () => {
    const adapter = new LocalRuntimeAdapter(opencodeHarness, { client: {} as LocalDispatchClient });
    const result = await adapter.runCodingTask({} as SandboxOps, INPUT, () => {}, { env: { A: "1" } });
    expect(result.status).toBe("error");
    expect(result.summary).toContain("local runtime");
  });
});

describe("leak guard", () => {
  const RESULT: CodingTaskResult = {
    status: "completed",
    exitCode: 0,
    stderrTail: `connect ECONNREFUSED ${SECRET}`,
    changedFiles: ["a.ts"],
    diff: "+const a = 1;",
    files: [{ path: "a.ts", content: "const a = 1;", encoding: "utf8" }],
    summary: `Tests failed against ${SECRET}`,
    testEvidence: { command: "npm test", exitCode: 1, outputTail: `db ${SECRET} down` },
    signals: [{ kind: "exec.settled", at: 1, detail: SECRET }],
  };
  const values = { DATABASE_URL: SECRET };

  it("scrubs every text field the result carries out", () => {
    const guarded = JSON.stringify(guardRunEnvLeak(RESULT, values));
    expect(guarded).not.toContain(SECRET);
    expect(guarded).toContain("[redacted:DATABASE_URL]");
  });

  it("fails the run and drops a change that contains an approved value", () => {
    for (const leak of [
      { diff: `+const url = "${SECRET}";` },
      { files: [{ path: "b.bin", content: btoa(`raw ${SECRET}`), encoding: "base64" as const }] },
    ]) {
      const guarded = guardRunEnvLeak({ ...RESULT, ...leak }, values);
      expect(guarded.status).toBe("error");
      expect(guarded.diff).toBe("");
      expect(guarded.files).toEqual([]);
      expect(JSON.stringify(guarded)).not.toContain(SECRET);
    }
  });

  it("ignores a value the repo already had — context, removed lines and file bodies aren't leaks", () => {
    const guarded = guardRunEnvLeak(
      {
        ...RESULT,
        diff: ` const url = "${SECRET}";\n-const old = "${SECRET}";\n+const added = 1;`,
        files: [{ path: "a.ts", content: `const url = "${SECRET}";\nconst added = 1;`, encoding: "utf8" }],
      },
      values,
    );
    expect(guarded.status).toBe("completed");
    expect(guarded.files).toHaveLength(1);
  });

  it("scrubs the JSON-escaped form a harness event line carries", () => {
    const quoted = 'pa"ss\\word-1234';
    const line = JSON.stringify({ type: "text", text: `using ${quoted}` });
    expect(runEnvScrubber({ DB_PASSWORD: quoted })(line)).not.toContain(JSON.stringify(quoted).slice(1, -1));
  });

  it("leaves values too short to match safely", () => {
    expect(runEnvScrubber({ FLAG: "on" })("turn it on")).toBe("turn it on");
  });

  it("discards the sealed blob once a run is terminal", () => {
    const run = {
      runId: "r",
      sandboxId: "s",
      repoUrl: "https://github.com/o/r",
      task: "t",
      baseBranch: "main",
      publishPullRequest: false,
      status: "running",
      generation: 1,
      createdAt: 0,
      updatedAt: 0,
      envNames: ["DATABASE_URL"],
      envDigest: "d".repeat(64),
      envSealed: "v1.blob",
    } as DelegatedRun;
    const done = applyRunEvents(run, [{ type: "run.completed", commandId: "c", at: 1, patch: { summary: "ok" } }], makeReceipt);
    expect(done?.envSealed).toBeUndefined();
    expect(done?.envDigest).toBe("d".repeat(64));
  });
});

describe("POST /api/runs/env-seal", () => {
  const env = { CodingOrchestrator: {}, ...KEY } as unknown as Env;
  const seal = (environmentVariables: unknown) =>
    handleRuns(
      new Request("https://shiba.test/api/runs/env-seal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentVariables }),
      }),
      env,
    );

  it("returns names, a digest and a sealed blob — not the value", async () => {
    const res = await seal(VARS);
    expect(res?.status).toBe(200);
    const text = await res!.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ names: ["DATABASE_URL"], digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("refuses a reserved name", async () => {
    const res = await seal([{ name: "GITHUB_TOKEN", value: SECRET }]);
    expect(res?.status).toBe(400);
    expect(await res!.text()).not.toContain(SECRET);
  });
});
