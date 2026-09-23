import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

// `mcp-gateway.js` pulls agents/mcp at module load; stub the base class —
// the registry seam under test never constructs it.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve(_path: string, _opts?: unknown) {
      return {
        fetch: async () => Response.json({ mcp: "served" }, { status: 200 }),
      };
    }
  },
}));

import { registerMemoryTools } from "../src/mcp-memory-tools.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import type { Env } from "../src/env.js";
import { Memory, memoryRegistryStub } from "../src/memory-do.js";
import type { Scope, TokenRecord } from "../src/agent-tokens.js";
import type { SqlRow } from "../src/memory-store.js";

/**
 * Pure-boundary harness: `env.Memory` serves real `Memory` DOs over
 * `node:sqlite` (the memory-store fake), `env.AI`/`env.MEMORY_VECTORS` are
 * deterministic fakes, and `env.AGENT_AUDIT` is the recording D1 — so tool
 * calls exercise the real store, registry join, and audit path end to end.
 */

const DIMS = 768;

/** Deterministic pseudo-embedding: text length spreads across dims so queries differ. */
function fakeEmbed(text: string): number[] {
  return Array.from({ length: DIMS }, (_, i) => ((text.length * (i + 1)) % 7) / 7);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

type FakeStub = { fetch: (r: Request) => Promise<Response> };

interface D1Call {
  sql: string;
  params: unknown[];
}

class FakeD1 {
  readonly calls: D1Call[] = [];
  prepare(sql: string) {
    const calls = this.calls;
    return {
      run: async () => {
        calls.push({ sql, params: [] });
        return { success: true, results: [], meta: {} };
      },
      bind: (...params: unknown[]) => ({
        run: async () => {
          calls.push({ sql, params });
          return { success: true, results: [], meta: {} };
        },
      }),
    };
  }
}

function makeEnv() {
  const stubs = new Map<string, FakeStub>();
  const vectors = new Map<string, { values: number[]; metadata?: { agent?: string } }>();
  const d1 = new FakeD1();
  const env = {
    Memory: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name?: string }) => {
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
      run: async (_model: string, input: { text: string }) => ({ data: [fakeEmbed(input.text)] }),
    },
    MEMORY_VECTORS: {
      upsert: async (
        entries: Array<{ id: string; values: number[]; metadata?: { agent?: string } }>,
      ) => {
        for (const entry of entries) {
          vectors.set(entry.id, { values: entry.values, metadata: entry.metadata });
        }
        return { ids: entries.map((e) => e.id), count: entries.length };
      },
      query: async (
        vector: number[],
        options?: { topK?: number; filter?: { agent?: string } },
      ) => {
        const matches = [...vectors.entries()]
          .filter(([, v]) =>
            options?.filter?.agent === undefined ? true : v.metadata?.agent === options.filter.agent,
          )
          .map(([id, v]) => ({ id, score: cosine(vector, v.values), metadata: v.metadata }))
          .sort((a, b) => b.score - a.score)
          .slice(0, options?.topK ?? 10);
        return { matches, count: matches.length };
      },
      deleteByIds: async (ids: string[]) => {
        for (const id of ids) vectors.delete(id);
        return { ids, count: ids.length };
      },
    },
    AGENT_AUDIT: d1 as unknown as D1Database,
  };
  return { env: env as unknown as Env, d1, vectors, stubs };
}

const caller: TokenRecord = {
  principal: "intern",
  scopes: ["memory:read", "memory:write"],
  created: 1,
  revoked: false,
};

const otherCaller: TokenRecord = {
  principal: "scout",
  scopes: ["memory:read", "memory:write"],
  created: 1,
  revoked: false,
};

function makeRegistry(env: Env) {
  const registry = createToolRegistry(env);
  registerMemoryTools(registry, env);
  return registry;
}

function resultData(result: { structuredContent?: unknown; content: unknown[] }) {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, any>;
}

const REGISTRY_BASE = "https://internal/internal/memory";

async function addSession(env: Env, agent: string, summary: string, started_at = 1_000) {
  const res = await (memoryRegistryStub(env) as unknown as FakeStub).fetch(
    new Request(`${REGISTRY_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, summary, started_at }),
    }),
  );
  if (!res.ok) throw new Error(`addSession failed: ${res.status}`);
}

describe("registerMemoryTools — scope map", () => {
  it("registers exactly the 4 tools with the brief's scope table", () => {
    const { env } = makeEnv();
    const registry = makeRegistry(env);
    const expected: Record<string, Scope> = {
      memory_recall: "memory:read",
      memory_sessions: "memory:read",
      memory_bank: "memory:write",
      memory_forget: "memory:write",
    };
    const actual = Object.fromEntries(registry.tools().map((t) => [t.name, t.scope]));
    expect(actual).toEqual(expected);
    expect(registry.tools()).toHaveLength(4);
  });
});

describe("registerMemoryTools — validation", () => {
  it("rejects malformed args with isError, never a throw", async () => {
    const { env } = makeEnv();
    const registry = makeRegistry(env);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["memory_recall", {}], // query required
      ["memory_recall", { query: "" }],
      ["memory_recall", { query: "   " }],
      ["memory_recall", { query: "x", limit: 0 }],
      ["memory_recall", { query: "x", limit: -3 }],
      ["memory_recall", { query: "x", limit: 1.5 }],
      ["memory_recall", { query: "x", limit: "10" }],
      ["memory_recall", { query: "x", limit: 101 }], // over Vectorize topK ceiling
      ["memory_bank", {}], // fact + source required
      ["memory_bank", { fact: "x" }],
      ["memory_bank", { fact: "", source: "run" }],
      ["memory_bank", { fact: "x", source: " " }],
      ["memory_bank", { fact: "x", source: "run", ttl: -1 }],
      ["memory_bank", { fact: "x", source: "run", ttl: "soon" }],
      ["memory_forget", {}], // fact_id required
      ["memory_forget", { fact_id: "" }],
      ["memory_sessions", { agent: "" }],
      ["memory_sessions", { limit: 0 }],
      ["memory_sessions", { limit: "many" }],
    ];
    for (const [tool, args] of cases) {
      const result = await registry.invoke(tool, args, caller);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

describe("registerMemoryTools — scope denial", () => {
  it("denies memory_bank to a read-only principal before any store call", async () => {
    const { env, d1 } = makeEnv();
    const registry = makeRegistry(env);
    const readOnly: TokenRecord = { ...caller, scopes: ["memory:read"] };
    const result = await registry.invoke(
      "memory_bank",
      { fact: "secret", source: "run" },
      readOnly,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      'missing scope "memory:write"',
    );
    const insert = d1.calls.find((c) => c.sql.startsWith("INSERT"))!;
    expect(insert.params[5]).toBe("denied");
  });
});

describe("registerMemoryTools — bank → recall → forget", () => {
  it("banks under the caller's principal and recalls the join shape across agents", async () => {
    const { env, vectors } = makeEnv();
    const registry = makeRegistry(env);

    const banked = resultData(
      await registry.invoke(
        "memory_bank",
        { fact: "deploys happen on Fridays", source: "run" },
        caller,
      ),
    );
    const factId = banked.fact.id as string;
    expect(factId).toMatch(/^fact_/);
    expect(banked.fact.agent).toBe("intern");
    expect(banked.fact.source).toBe("run");
    // The write went to the principal's own stub: a second principal
    // banks elsewhere and both facts join in one cross-agent recall.
    await registry.invoke(
      "memory_bank",
      { fact: "a much longer fact about deploy windows", source: "email" },
      otherCaller,
    );

    const recalled = resultData(
      await registry.invoke("memory_recall", { query: "deploy" }, caller),
    );
    expect(recalled.query).toBe("deploy");
    expect(recalled.facts).toHaveLength(2);
    // Join shape: exactly id/fact/source/agent/score, ranked desc.
    for (const hit of recalled.facts) {
      expect(Object.keys(hit).sort()).toEqual(["agent", "fact", "id", "score", "source"]);
    }
    expect(recalled.facts.map((f: { agent: string }) => f.agent).sort()).toEqual([
      "intern",
      "scout",
    ]);
    const scores = recalled.facts.map((f: { score: number }) => f.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const mine = recalled.facts.find((f: { id: string }) => f.id === factId);
    expect(mine).toMatchObject({ fact: "deploys happen on Fridays", source: "run", agent: "intern" });

    const forgotten = resultData(
      await registry.invoke("memory_forget", { fact_id: factId }, caller),
    );
    expect(forgotten).toEqual({ ok: true, id: factId });
    // Row, vector, and registry entry are all gone.
    expect(vectors.has(factId)).toBe(false);
    const after = resultData(
      await registry.invoke("memory_recall", { query: "deploy" }, caller),
    );
    expect(after.facts.map((f: { id: string }) => f.id)).not.toContain(factId);
    const gone = await registry.invoke("memory_forget", { fact_id: factId }, caller);
    expect(gone.isError).toBe(true);
  });

  it("honours a ttl on bank and drops the fact after expiry", async () => {
    const { env, vectors } = makeEnv();
    const registry = makeRegistry(env);
    const banked = resultData(
      await registry.invoke(
        "memory_bank",
        { fact: "short-lived", source: "run", ttl: Date.now() - 1 },
        caller,
      ),
    );
    const factId = banked.fact.id as string;
    expect(banked.fact.ttl).not.toBeNull();
    // The expired row is purged on the next store read — recall joins
    // nothing and the lazy purge collects the orphaned vector too.
    const recalled = resultData(
      await registry.invoke("memory_recall", { query: "short" }, caller),
    );
    expect(recalled.facts.map((f: { id: string }) => f.id)).not.toContain(factId);
    expect(vectors.has(factId)).toBe(false);
  });

  it("refuses to bank on a stub whose name is the reserved registry", async () => {
    const { env } = makeEnv();
    const registry = makeRegistry(env);
    // "global" is the reserved registry instance — banking there would
    // be a self-recursive write; the DO's guard surfaces as a tool error.
    const globalCaller: TokenRecord = { ...caller, principal: "global" };
    const result = await registry.invoke(
      "memory_bank",
      { fact: "x", source: "run" },
      globalCaller,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("per-agent");
  });
});

describe("registerMemoryTools — sessions", () => {
  it("lists distilled sessions and scopes them by agent", async () => {
    const { env } = makeEnv();
    const registry = makeRegistry(env);
    await addSession(env, "intern", "shipped the inbox tab", 2_000);
    await addSession(env, "scout", "scouted competitors", 1_000);

    const all = resultData(await registry.invoke("memory_sessions", {}, caller));
    expect(all.agent).toBeNull();
    expect(all.sessions).toHaveLength(2);
    expect(all.sessions[0]).toMatchObject({ agent: "intern", summary: "shipped the inbox tab" });

    const scoped = resultData(
      await registry.invoke("memory_sessions", { agent: "scout" }, caller),
    );
    expect(scoped.agent).toBe("scout");
    expect(scoped.sessions).toEqual([
      expect.objectContaining({ agent: "scout", summary: "scouted competitors" }),
    ]);

    const capped = resultData(
      await registry.invoke("memory_sessions", { limit: 1 }, caller),
    );
    expect(capped.sessions).toHaveLength(1);
  });
});
