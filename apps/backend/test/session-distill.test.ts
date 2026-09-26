import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: vi.fn() }));
vi.mock("ai", () => ({ tool: vi.fn() }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { Env } from "../src/env.js";
import { Memory } from "../src/memory-do.js";
import type { FactRecord, SessionRecord, SqlRow } from "../src/memory-store.js";
import { formatAgentResult, type CodingTaskResult } from "../src/opencode-input.js";
import { createPendingApproval } from "../src/pending-approvals.js";
import { createRun } from "../src/runs.js";
import {
  distillSession,
  MAX_DISTILL_FACTS,
  memoryEnabled,
  parseDistilled,
  runTranscript,
} from "../src/session-distill.js";

/**
 * Pure-boundary harness mirroring test/mcp-memory-tools: `env.Memory` serves
 * real `Memory` DOs over `node:sqlite`, `env.AI` answers both call shapes
 * (chat distillation vs embedding), `env.MEMORY_VECTORS` is a stub map — so
 * distillSession exercises the real bank/session routes end to end.
 */
const DIMS = 768;
const REGISTRY_BASE = "https://internal/internal/memory";

function fakeEmbed(text: string): number[] {
  return Array.from({ length: DIMS }, (_, i) => ((text.length * (i + 1)) % 7) / 7);
}

type FakeStub = { fetch: (r: Request) => Promise<Response> };

interface AiCall {
  model: string;
  input: Record<string, unknown>;
}

function makeEnv(opts: {
  distill?: (call: AiCall) => unknown;
  memoryEnabled?: string;
  memoryFails?: boolean;
}) {
  const stubs = new Map<string, FakeStub>();
  const aiCalls: AiCall[] = [];
  const env = {
    ORCHESTRATOR_MODEL: "@cf/test/orchestrator",
    MEMORY_ENABLED: opts.memoryEnabled,
    Memory: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name?: string }) => {
        if (opts.memoryFails) {
          throw new Error("Memory namespace unavailable");
        }
        const name = id.name ?? "";
        let stub = stubs.get(name);
        if (!stub) {
          const db = new DatabaseSync(":memory:");
          const ctx = {
            id: { name },
            storage: {
              sql: {
                exec: (sql: string, ...params: unknown[]) => ({
                  toArray: () => db.prepare(sql).all(...(params as any[])) as SqlRow[],
                }),
              },
            },
            blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
            waitUntil: () => {},
          };
          const obj = new Memory(ctx as unknown as DurableObjectState, env as unknown as Env);
          stub = { fetch: (request: Request) => obj.fetch(request) };
          stubs.set(name, stub);
        }
        return stub;
      },
    },
    AI: {
      run: async (model: string, input: Record<string, unknown>) => {
        aiCalls.push({ model, input });
        // Chat call (session distillation) vs embedding call (Memory bank).
        if (input.messages !== undefined) {
          return opts.distill
            ? opts.distill({ model, input })
            : { response: JSON.stringify({ summary: "Ran the task.", facts: ["Did the thing."] }) };
        }
        return { data: [fakeEmbed(String(input.text))] };
      },
    },
    MEMORY_VECTORS: {
      upsert: async () => ({ ids: [], count: 0 }),
      query: async () => ({ matches: [], count: 0 }),
      deleteByIds: async () => ({ ids: [], count: 0 }),
    },
  };
  return { env: env as unknown as Env, aiCalls, stubs };
}

async function listFacts(env: Env, agent: string): Promise<FactRecord[]> {
  const stub = env.Memory.get(env.Memory.idFromName(agent)) as unknown as FakeStub;
  const res = await stub.fetch(new Request(`${REGISTRY_BASE}/facts`));
  const body = (await res.json()) as { facts: FactRecord[] };
  return body.facts;
}

async function listSessions(env: Env): Promise<SessionRecord[]> {
  const stub = env.Memory.get(env.Memory.idFromName("global")) as unknown as FakeStub;
  const res = await stub.fetch(new Request(`${REGISTRY_BASE}/sessions`));
  const body = (await res.json()) as { sessions: SessionRecord[] };
  return body.sessions;
}

function completedRun() {
  const run = createRun({
    runId: "agent-tool:call-1",
    sandboxId: "sbx-1",
    repoUrl: "https://github.com/owner/repo",
    task: "Fix the login redirect.",
    baseBranch: "main",
    publishPullRequest: false,
    now: 1_700_000_000_000,
  });
  return { ...run, status: "completed" as const, summary: "Fixed the redirect." };
}

describe("T10 memoryEnabled flag", () => {
  it("defaults to enabled; only explicit off-values disable", () => {
    expect(memoryEnabled(undefined)).toBe(true);
    expect(memoryEnabled("")).toBe(true);
    expect(memoryEnabled("true")).toBe(true);
    for (const off of ["0", "false", "off", "no", "FALSE", " 0 "]) {
      expect(memoryEnabled(off)).toBe(false);
    }
  });
});

describe("T10 runTranscript input shaping", () => {
  it("carries task, repo, status, summary, error, receipt tail, and bounded diff", () => {
    const run = {
      ...completedRun(),
      error: "boom",
      diff: `HEAD ${"d".repeat(20_000)}`,
      receipts: Array.from({ length: 12 }, (_, i) => ({
        at: i,
        kind: "code" as const,
        message: `step ${i}`,
      })),
    };
    const text = runTranscript(run);
    expect(text).toContain("Task: Fix the login redirect.");
    expect(text).toContain("Repository: https://github.com/owner/repo (main)");
    expect(text).toContain("Status: completed");
    expect(text).toContain("Summary: Fixed the redirect.");
    expect(text).toContain("Error: boom");
    expect(text).toContain("[code] step 11");
    expect(text).not.toContain("step 0");
    expect(text).toContain("…[truncated");
  });
});

describe("T10 parseDistilled", () => {
  it("parses a clean JSON response", () => {
    const parsed = parseDistilled({ response: '{"summary":"s","facts":["a","b"]}' });
    expect(parsed).toEqual({ summary: "s", facts: ["a", "b"] });
  });

  it("tolerates prose and fences around the object", () => {
    const parsed = parseDistilled({
      response: 'Here you go:\n```json\n{"summary":"s","facts":["a"]}\n```\nDone.',
    });
    expect(parsed?.facts).toEqual(["a"]);
  });

  it("caps facts at 10, drops non-strings and blanks", () => {
    const facts = Array.from({ length: 14 }, (_, i) => `fact ${i}`);
    const parsed = parseDistilled({
      response: JSON.stringify({ summary: "s", facts: [...facts, 7, "", null] }),
    });
    expect(parsed?.facts).toHaveLength(MAX_DISTILL_FACTS);
    expect(parsed?.facts.every((f) => typeof f === "string" && f !== "")).toBe(true);
  });

  it("returns null on garbage, empty output, or a fact-less object", () => {
    expect(parseDistilled({ response: "no json at all" })).toBeNull();
    expect(parseDistilled({ response: "" })).toBeNull();
    expect(parseDistilled({ response: '{"facts":[],"summary":""}' })).toBeNull();
    expect(parseDistilled({})).toBeNull();
    expect(parseDistilled(null)).toBeNull();
  });

  it("redacts secret-shaped strings the model echoes back", () => {
    const parsed = parseDistilled({
      response: JSON.stringify({
        summary: "Pushed with token ghp_ABCDEFGH1234.",
        facts: ["Used api_key='supersecret123' for auth.", "safe fact"],
      }),
    });
    expect(parsed?.facts).toEqual(["Used [redacted] for auth.", "safe fact"]);
    expect(parsed?.summary).toBe("Pushed with token [redacted].");
  });
});

describe("T10 distillSession", () => {
  it("banks ≤10 facts on the agent stub and records one session on the registry", async () => {
    const { env } = makeEnv({
      distill: () => ({
        response: JSON.stringify({
          summary: "Fixed the login redirect and verified the flow.",
          facts: ["Redirect loop was caused by a stale cookie.", "Login flow verified end to end."],
        }),
      }),
    });
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result).toEqual({ distilled: true, factsBanked: 2, sessionRecorded: true });

    const facts = await listFacts(env, "intern");
    // Same-ms created_at — the store's newest-first order is unspecified here.
    expect(facts.map((f) => f.fact).sort()).toEqual([
      "Login flow verified end to end.",
      "Redirect loop was caused by a stale cookie.",
    ]);
    expect(facts.every((f) => f.source === "run")).toBe(true);

    const sessions = await listSessions(env);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "agent-tool:call-1",
      agent: "intern",
      summary: "Fixed the login redirect and verified the flow.",
      started_at: 1_700_000_000_000,
    });
  });

  it("passes the transcript through the configured orchestrator model", async () => {
    const { env, aiCalls } = makeEnv({});
    await distillSession(env, completedRun(), { agent: "intern" });
    const call = aiCalls.find((c) => c.input.messages !== undefined);
    expect(call?.model).toBe("@cf/test/orchestrator");
    const prompt = (call?.input.messages as Array<{ content: string }>)[0]?.content ?? "";
    expect(prompt).toContain("Task: Fix the login redirect.");
    expect(prompt).toContain("at most 10 durable facts");
  });

  it("caps banked facts at 10 even when the model emits more", async () => {
    const { env } = makeEnv({
      distill: () => ({
        response: JSON.stringify({
          summary: "s",
          facts: Array.from({ length: 15 }, (_, i) => `fact ${i}`),
        }),
      }),
    });
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result.factsBanked).toBe(MAX_DISTILL_FACTS);
    expect(await listFacts(env, "intern")).toHaveLength(MAX_DISTILL_FACTS);
  });

  it("does nothing when MEMORY_ENABLED is off — no model call, no stub writes", async () => {
    const { env, aiCalls, stubs } = makeEnv({ memoryEnabled: "0" });
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result).toEqual({ distilled: false, factsBanked: 0, sessionRecorded: false });
    expect(aiCalls).toHaveLength(0);
    expect(stubs.size).toBe(0);
  });

  it("resolves without banking when the model call fails", async () => {
    const { env } = makeEnv({
      distill: () => {
        throw new Error("AI quota exhausted");
      },
    });
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result).toEqual({ distilled: false, factsBanked: 0, sessionRecorded: false });
    expect(await listSessions(env)).toHaveLength(0);
  });

  it("resolves without banking when the model returns no usable output", async () => {
    const { env } = makeEnv({ distill: () => ({ response: "unparsable prose" }) });
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result).toEqual({ distilled: false, factsBanked: 0, sessionRecorded: false });
  });

  it("isolates store failures — resolves instead of rejecting", async () => {
    const { env } = makeEnv({ memoryFails: true });
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result).toEqual({ distilled: true, factsBanked: 0, sessionRecorded: false });
  });

  it("is idempotent on replay — deterministic ids dedupe facts and the session", async () => {
    const { env } = makeEnv({});
    const run = completedRun();
    const first = await distillSession(env, run, { agent: "intern" });
    const second = await distillSession(env, run, { agent: "intern" });
    expect(first).toEqual({ distilled: true, factsBanked: 1, sessionRecorded: true });
    expect(second).toEqual({ distilled: true, factsBanked: 1, sessionRecorded: true });
    expect(await listFacts(env, "intern")).toHaveLength(1);
    expect(await listSessions(env)).toHaveLength(1);
  });

  it("does not count a cross-agent fact-id collision as banked", async () => {
    const { env } = makeEnv({
      distill: () => ({
        response: JSON.stringify({ summary: "s", facts: ["f"] }),
      }),
    });
    // Another agent already owns the deterministic distill id — the bank
    // 409s on the registry claim and the row never lands on our stub.
    const other = env.Memory.get(env.Memory.idFromName("other")) as unknown as FakeStub;
    const claim = await other.fetch(
      new Request(`${REGISTRY_BASE}/facts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "distill_agent-tool:call-1_0",
          fact: "foreign fact",
          source: "manual",
        }),
      }),
    );
    expect(claim.status).toBe(201);
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result).toEqual({ distilled: true, factsBanked: 0, sessionRecorded: true });
    expect(await listFacts(env, "intern")).toHaveLength(0);
    const others = await listFacts(env, "other");
    expect(others).toHaveLength(1);
    expect(others[0]?.fact).toBe("foreign fact");
  });

  it("does not count a foreign session-row collision as recorded", async () => {
    const { env } = makeEnv({});
    // A different run already wrote a session row under this run id.
    const registry = env.Memory.get(env.Memory.idFromName("global")) as unknown as FakeStub;
    const seed = await registry.fetch(
      new Request(`${REGISTRY_BASE}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "agent-tool:call-1",
          agent: "other",
          summary: "a different run's record",
          started_at: 1,
        }),
      }),
    );
    expect(seed.status).toBe(201);
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result).toEqual({ distilled: true, factsBanked: 1, sessionRecorded: false });
    const sessions = await listSessions(env);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agent).toBe("other");
  });

  it("persists redacted text when the model echoes secrets back", async () => {
    const { env } = makeEnv({
      distill: () => ({
        response: JSON.stringify({
          summary: "Pushed with token ghp_ABCDEFGH1234.",
          facts: ["Used api_key='supersecret123' for auth."],
        }),
      }),
    });
    const result = await distillSession(env, completedRun(), { agent: "intern" });
    expect(result).toEqual({ distilled: true, factsBanked: 1, sessionRecorded: true });
    const facts = await listFacts(env, "intern");
    expect(facts[0]?.fact).toBe("Used [redacted] for auth.");
    expect(JSON.stringify(facts)).not.toContain("supersecret123");
    const sessions = await listSessions(env);
    expect(sessions[0]?.summary).toBe("Pushed with token [redacted].");
    expect(JSON.stringify(sessions)).not.toContain("ghp_ABCDEFGH1234");
  });
});

describe("T10 orchestrator wiring", () => {
  function makeOrchestrator(env: Env) {
    const pending: Promise<unknown>[] = [];
    const instance: any = Object.create(CodingOrchestrator.prototype);
    instance.state = { runs: [] };
    instance.env = env;
    instance.name = "intern";
    instance.ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
    instance.keepAliveWhile = (fn: () => Promise<unknown>) => fn();
    instance.setState = (s: unknown) => {
      instance.state = s;
    };
    return { instance, pending };
  }

  const DELEGATE_INPUT = {
    repoUrl: "https://github.com/owner/repo",
    task: "Fix the login redirect.",
    baseBranch: "main",
    publishPullRequest: false,
  };

  function completedResult(): CodingTaskResult {
    return {
      status: "completed",
      exitCode: 0,
      stderrTail: "",
      changedFiles: ["a.ts"],
      diff: "diff --git a/a.ts",
      files: [{ path: "a.ts", content: "x", encoding: "utf8" }],
      summary: "done",
    };
  }

  it("a completed run still completes when distillation blows up", async () => {
    const { env } = makeEnv({
      distill: () => {
        throw new Error("AI down");
      },
    });
    const { instance, pending } = makeOrchestrator(env);
    const childExecute = async () => formatAgentResult(completedResult());
    const out = await instance.executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-ok");
    expect(typeof out).toBe("string");
    expect(instance.state.runs[0]?.status).toBe("completed");
    await Promise.all(pending);
    expect(instance.state.runs[0]?.status).toBe("completed");
  });

  it("an error run distills too, and the run is unaffected by distill failures", async () => {
    const { env, aiCalls } = makeEnv({ memoryFails: true });
    const { instance, pending } = makeOrchestrator(env);
    const childExecute = async () =>
      formatAgentResult({ ...completedResult(), status: "error", exitCode: 1, summary: "boom" });
    await instance.executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-err");
    expect(instance.state.runs[0]?.status).toBe("error");
    await Promise.allSettled(pending);
    expect(aiCalls.some((c) => c.input.messages !== undefined)).toBe(true);
    expect(instance.state.runs[0]?.status).toBe("error");
  });

  it("a run landing 'cancelled' does not distill", async () => {
    const { env, aiCalls } = makeEnv({});
    const { instance, pending } = makeOrchestrator(env);
    const abort = new Error("aborted mid-run");
    abort.name = "AbortError";
    const childExecute = async () => {
      throw abort;
    };
    await expect(
      instance.executeDelegatedTask(DELEGATE_INPUT, childExecute, "call-abort"),
    ).rejects.toThrow("aborted mid-run");
    expect(instance.state.runs[0]?.status).toBe("cancelled");
    await Promise.allSettled(pending);
    expect(aiCalls.some((c) => c.input.messages !== undefined)).toBe(false);
    expect(await listSessions(env)).toHaveLength(0);
  });

  it("a run reclaimed to 'unknown' does not distill", async () => {
    const { env, aiCalls } = makeEnv({});
    const { instance, pending } = makeOrchestrator(env);
    instance.state.runs = [
      {
        ...completedRun(),
        runId: "agent-tool:stale",
        status: "running",
        updatedAt: Date.now() - 46 * 60 * 1000,
      },
    ];
    await instance.reclaimRuns();
    expect(instance.state.runs[0]?.status).toBe("unknown");
    await Promise.allSettled(pending);
    expect(aiCalls.some((c) => c.input.messages !== undefined)).toBe(false);
    expect(await listSessions(env)).toHaveLength(0);
  });

  function queueRunApproval(instance: any, approvalId: string) {
    instance.state.pendingApprovals = createPendingApproval([], {
      threadKey: "default",
      approvalId,
      repoUrl: "https://github.com/owner/repo",
      task: "Fix the login redirect.",
      createdAt: Date.now(),
    });
  }

  it("the approval-resolve fallback distills when it is the transition that lands 'error'", async () => {
    const { env, aiCalls } = makeEnv({});
    const { instance, pending } = makeOrchestrator(env);
    // delegate.execute throws before its inner `finish` seam ran, so the
    // dispatch fallback is the terminal transition.
    instance.getTools = () => ({
      delegate_coding_task: {
        execute: async () => {
          throw new Error("tool dispatch failed");
        },
      },
    });
    queueRunApproval(instance, "ap-fallback");
    const res = await instance.resolveApproval({
      threadKey: "default",
      approvalId: "ap-fallback",
      approved: true,
      decidedBy: "test",
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.allSettled(pending);
    const run = instance.state.runs[0];
    expect(run?.status).toBe("error");
    expect(run?.errorCode).toBeDefined();
    expect(aiCalls.some((c) => c.input.messages !== undefined)).toBe(true);
    expect(await listFacts(env, "intern")).toHaveLength(1);
    expect(await listSessions(env)).toHaveLength(1);
  });

  it("the approval-resolve fallback drops its write when a terminal state already landed", async () => {
    const { env, aiCalls } = makeEnv({});
    const { instance, pending } = makeOrchestrator(env);
    // delegate.execute lands a terminal transition itself (the inner
    // `finish` seam's job), then throws — the fallback's fenced write must
    // drop instead of overwriting, and must not distill twice.
    instance.getTools = () => ({
      delegate_coding_task: {
        execute: async (_input: unknown, options?: { toolCallId?: string }) => {
          const runId = `agent-tool:${options?.toolCallId}`;
          instance.store.transition(runId, "error", {
            error: "inner finish landed",
            errorCode: "internal_error",
          });
          throw new Error("dispatch failed after finish");
        },
      },
    });
    queueRunApproval(instance, "ap-fenced");
    const res = await instance.resolveApproval({
      threadKey: "default",
      approvalId: "ap-fenced",
      approved: true,
      decidedBy: "test",
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.allSettled(pending);
    const run = instance.state.runs[0];
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("inner finish landed");
    expect(aiCalls.some((c) => c.input.messages !== undefined)).toBe(false);
  });

  it("the approval-resolve fallback landing 'cancelled' does not distill", async () => {
    const { env, aiCalls } = makeEnv({});
    const { instance, pending } = makeOrchestrator(env);
    const abort = new Error("dispatch aborted");
    abort.name = "AbortError";
    instance.getTools = () => ({
      delegate_coding_task: {
        execute: async () => {
          throw abort;
        },
      },
    });
    queueRunApproval(instance, "ap-abort");
    const res = await instance.resolveApproval({
      threadKey: "default",
      approvalId: "ap-abort",
      approved: true,
      decidedBy: "test",
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.allSettled(pending);
    const run = instance.state.runs[0];
    expect(run?.status).toBe("cancelled");
    expect(aiCalls.some((c) => c.input.messages !== undefined)).toBe(false);
    expect(await listSessions(env)).toHaveLength(0);
  });
});
