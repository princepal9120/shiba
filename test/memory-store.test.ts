import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { Memory, memoryRegistryStub, memoryStub } from "../src/memory-do.js";
import {
  MEMORY_SCHEMA,
  MEMORY_STATEMENTS,
  MemoryStore,
  type SqlExec,
  type SqlRow,
} from "../src/memory-store.js";
import { InputError } from "../src/security.js";

/**
 * `node:sqlite` adapter for the store's one-statement-per-call exec contract —
 * the same shape the MemoryDO adapter wraps around `ctx.storage.sql.exec`.
 */
function makeStore(): MemoryStore {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExec = (sql, ...params) => db.prepare(sql).all(...params) as SqlRow[];
  const store = new MemoryStore(exec);
  store.init();
  return store;
}

describe("schema", () => {
  it("executes MEMORY_SCHEMA statements and survives a second init", () => {
    const store = makeStore();
    const fact = store.bankFact({ fact: "deploys run on Fridays", source: "run", nowMs: 1_000 });
    store.init();
    expect(store.getFact(fact.id)?.fact).toBe("deploys run on Fridays");
  });

  it("exports MEMORY_SCHEMA as a bundle of per-call statements", () => {
    const db = new DatabaseSync(":memory:");
    const exec: SqlExec = (sql, ...params) => db.prepare(sql).all(...params) as SqlRow[];
    for (const statement of MEMORY_SCHEMA.statements) {
      exec(statement);
    }
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as SqlRow[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["facts", "sessions", "fact_registry"]),
    );
    expect(MEMORY_SCHEMA.statements).toBe(MEMORY_STATEMENTS);
    expect(MEMORY_SCHEMA.ddl).toContain("CREATE TABLE");
  });
});

describe("facts CRUD", () => {
  it("banks a durable fact and reads it back", () => {
    const store = makeStore();
    const fact = store.bankFact({ fact: "owner prefers dark mode", source: "manual" });
    expect(fact.id).toMatch(/^fact_/);
    expect(fact.source).toBe("manual");
    expect(fact.ttl).toBeNull();
    expect(fact.embedding_id).toBeNull();
    expect(store.getFact(fact.id)).toMatchObject({ fact: "owner prefers dark mode" });
  });

  it("honours a caller-provided id and embedding id", () => {
    const store = makeStore();
    const fact = store.bankFact({
      id: "fact_custom",
      fact: "x",
      source: "run",
      embedding_id: "fact_custom",
    });
    expect(fact.id).toBe("fact_custom");
    expect(fact.embedding_id).toBe("fact_custom");
  });

  it("lists facts newest-first and forgets on demand", () => {
    const store = makeStore();
    const a = store.bankFact({ fact: "a", source: "run", nowMs: 1_000 });
    const b = store.bankFact({ fact: "b", source: "email", nowMs: 2_000 });
    expect(store.listFacts().map((f) => f.id)).toEqual([b.id, a.id]);
    expect(store.listFacts({ limit: 1 }).map((f) => f.id)).toEqual([b.id]);
    expect(store.forgetFact(a.id)).toBe(true);
    expect(store.getFact(a.id)).toBeNull();
    expect(store.forgetFact(a.id)).toBe(false);
  });

  it("rejects empty fact/source", () => {
    const store = makeStore();
    expect(() => store.bankFact({ fact: "  ", source: "run" })).toThrow(InputError);
    expect(() => store.bankFact({ fact: "x", source: "" })).toThrow(InputError);
  });
});

describe("ttl purge on read", () => {
  it("purges expired facts lazily and keeps durable rows", () => {
    const store = makeStore();
    const now = 10_000;
    const expired = store.bankFact({ fact: "short-lived", source: "run", ttl: now - 1, nowMs: now });
    const durable = store.bankFact({ fact: "forever", source: "run", nowMs: now });
    const future = store.bankFact({ fact: "still fresh", source: "run", ttl: now + 60_000, nowMs: now });
    // Purge happens inside the read path — no sweeper exists.
    expect(store.getFact(expired.id, now)).toBeNull();
    expect(store.listFacts({ nowMs: now }).map((f) => f.id)).toEqual([future.id, durable.id]);
    // The expired row is gone from storage, not just filtered from output.
    expect(store.listFacts({ nowMs: now - 60_000 }).map((f) => f.id)).not.toContain(expired.id);
  });

  it("rejects a non-finite ttl", () => {
    const store = makeStore();
    expect(() => store.bankFact({ fact: "x", source: "run", ttl: Number.NaN })).toThrow(InputError);
  });
});

describe("sessions", () => {
  it("records sessions and filters by agent", () => {
    const store = makeStore();
    const a = store.addSession({ agent: "intern", summary: "did the thing", started_at: 1_000 });
    const b = store.addSession({ agent: "scout", summary: "scouted", started_at: 2_000 });
    expect(store.listSessions().map((s) => s.id)).toEqual([b.id, a.id]);
    expect(store.listSessions({ agent: "intern" }).map((s) => s.id)).toEqual([a.id]);
    expect(store.listSessions({ agent: "intern" })[0]?.summary).toBe("did the thing");
  });

  it("rejects empty agent/summary", () => {
    const store = makeStore();
    expect(() => store.addSession({ agent: " ", summary: "x" })).toThrow(InputError);
    expect(() => store.addSession({ agent: "intern", summary: "" })).toThrow(InputError);
  });
});

describe("fact registry", () => {
  it("indexes fact ids to agents and lists the agent set", () => {
    const store = makeStore();
    store.registerFact({ fact_id: "fact_1", agent: "intern", nowMs: 1_000 });
    store.registerFact({ fact_id: "fact_2", agent: "scout", nowMs: 2_000 });
    store.registerFact({ fact_id: "fact_3", agent: "intern", nowMs: 3_000 });
    expect(store.factOwner("fact_2")).toBe("scout");
    expect(store.factOwner("missing")).toBeNull();
    expect(store.listRegisteredAgents()).toEqual(["intern", "scout"]);
    expect(store.listRegistryEntries().map((e) => e.fact_id)).toEqual(["fact_3", "fact_2", "fact_1"]);
    expect(store.listRegistryEntries({ agent: "intern" }).map((e) => e.fact_id)).toEqual([
      "fact_3",
      "fact_1",
    ]);
  });

  it("re-registers idempotently and unregisters on forget", () => {
    const store = makeStore();
    store.registerFact({ fact_id: "fact_1", agent: "intern" });
    store.registerFact({ fact_id: "fact_1", agent: "intern" });
    expect(store.listRegistryEntries()).toHaveLength(1);
    expect(store.unregisterFact("fact_1")).toBe(true);
    expect(store.factOwner("fact_1")).toBeNull();
    expect(store.unregisterFact("fact_1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DO route-level tests — fake ctx.storage.sql over node:sqlite, a stub map
// keyed by idFromName input, and mocked AI/Vectorize bindings so no real
// embedding or index call leaves the process.
// ---------------------------------------------------------------------------

interface FakeStub {
  fetch: (request: Request) => Promise<Response>;
}

const DIMS = 768;

/** Deterministic pseudo-embedding: text length spreads across dims so queries differ. */
function fakeEmbed(text: string): number[] {
  const values = Array.from({ length: DIMS }, (_, i) => ((text.length * (i + 1)) % 7) / 7);
  return values;
}

/** Cosine-similarity mock index over an in-memory vector map. */
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

interface Harness {
  stub: (agent: string) => FakeStub;
  registry: FakeStub;
  vectors: Map<string, { values: number[]; metadata?: { agent?: string } }>;
}

function makeHarness(): Harness {
  const stubs = new Map<string, FakeStub>();
  const vectors = new Map<string, { values: number[]; metadata?: { agent?: string } }>();
  const create = (name: string): FakeStub => {
    const db = new DatabaseSync(":memory:");
    const ctx = {
      id: { name, toString: () => `id:${name}`, equals: () => false },
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
    const obj = new Memory(ctx as unknown as DurableObjectState, env);
    return { fetch: (request: Request) => obj.fetch(request) };
  };
  const env = {
    Memory: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}`, equals: () => false }),
      get: (id: { name?: string }) => {
        const name = id.name ?? "";
        let stub = stubs.get(name);
        if (!stub) {
          stub = create(name);
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
      getByIds: async () => [],
      describe: async () => ({}),
      insert: async () => ({ ids: [], count: 0 }),
    },
  } as unknown as Env;
  return {
    stub: (agent) => memoryStub(env, agent) as unknown as FakeStub,
    registry: memoryRegistryStub(env) as unknown as FakeStub,
    vectors,
  };
}

const BASE = "https://internal/internal/memory";

function get(stub: FakeStub, path: string): Promise<Response> {
  return stub.fetch(new Request(`${BASE}${path}`));
}

function send(stub: FakeStub, method: string, path: string, body?: unknown): Promise<Response> {
  return stub.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function bank(stub: FakeStub, fact: string, source = "run", extra: Record<string, unknown> = {}) {
  const res = await send(stub, "POST", "/facts", { fact, source, ...extra });
  return { res, body: (await res.json()) as { fact?: { id: string } } };
}

describe("Memory DO routes", () => {
  it("banks a fact on the agent stub and indexes it on the registry", async () => {
    const h = makeHarness();
    const { res, body } = await bank(h.stub("intern"), "deploys happen on Fridays");
    expect(res.status).toBe(201);
    const id = body.fact?.id ?? "";
    expect(id).toMatch(/^fact_/);
    expect(h.vectors.has(id)).toBe(true);
    // The registry row makes the fact discoverable cross-agent.
    const agents = (await (await get(h.registry, "/registry")).json()) as { agents: string[] };
    expect(agents.agents).toEqual(["intern"]);
    const fetched = (await (await get(h.registry, `/facts/${id}`)).json()) as {
      fact: { id: string; agent: string };
    };
    expect(fetched.fact.agent).toBe("intern");
  });

  it("merges cross-agent fact listing on the registry stub", async () => {
    const h = makeHarness();
    await bank(h.stub("intern"), "alpha");
    await bank(h.stub("scout"), "beta");
    const body = (await (await get(h.registry, "/facts")).json()) as {
      facts: Array<{ fact: string; agent: string }>;
    };
    expect(body.facts).toHaveLength(2);
    expect(body.facts.map((f) => f.agent).sort()).toEqual(["intern", "scout"]);
    const scoped = (await (await get(h.registry, "/facts?agent=scout")).json()) as {
      facts: Array<{ agent: string }>;
    };
    expect(scoped.facts).toEqual([expect.objectContaining({ agent: "scout" })]);
  });

  it("recalls facts by semantic query with scores, joined across agents", async () => {
    const h = makeHarness();
    await bank(h.stub("intern"), "alpha");
    await bank(h.stub("scout"), "a much longer fact about deploys");
    const body = (await (await get(h.registry, "/facts/search?q=a%20query")).json()) as {
      facts: Array<{ id: string; agent: string; score: number }>;
    };
    expect(body.facts).toHaveLength(2);
    expect(body.facts.every((f) => typeof f.score === "number")).toBe(true);
    // Scores are returned ranked — matches arrive sorted desc.
    const scores = body.facts.map((f) => f.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("scopes recall to one agent via ?agent=", async () => {
    const h = makeHarness();
    await bank(h.stub("intern"), "alpha");
    await bank(h.stub("scout"), "alpha");
    const body = (await (await get(h.registry, "/facts/search?q=x&agent=intern")).json()) as {
      facts: Array<{ agent: string }>;
    };
    expect(body.facts).toHaveLength(1);
    expect(body.facts[0]?.agent).toBe("intern");
  });

  it("forgets a fact: row, registry entry, and vector all go away", async () => {
    const h = makeHarness();
    const { body } = await bank(h.stub("intern"), "doomed");
    const id = body.fact?.id ?? "";
    const res = await send(h.registry, "DELETE", `/facts/${id}`);
    expect(res.status).toBe(200);
    expect(h.vectors.has(id)).toBe(false);
    expect((await get(h.registry, `/facts/${id}`)).status).toBe(404);
    const agents = (await (await get(h.registry, "/registry")).json()) as { agents: string[] };
    expect(agents.agents).toEqual([]);
  });

  it("serves sessions on the registry and rejects them on agent stubs", async () => {
    const h = makeHarness();
    const res = await send(h.registry, "POST", "/sessions", {
      agent: "intern",
      summary: "did the thing",
    });
    expect(res.status).toBe(201);
    const listed = (await (await get(h.registry, "/sessions")).json()) as {
      sessions: Array<{ agent: string }>;
    };
    expect(listed.sessions).toEqual([expect.objectContaining({ agent: "intern" })]);
    expect((await send(h.stub("intern"), "POST", "/sessions", { agent: "x", summary: "y" })).status).toBe(
      400,
    );
  });

  it("rejects bank on the registry stub", async () => {
    const h = makeHarness();
    expect((await send(h.registry, "POST", "/facts", { fact: "x", source: "run" })).status).toBe(400);
  });

  it("supports a duration-style ttl_ms on bank", async () => {
    const h = makeHarness();
    const { res, body } = await bank(h.stub("intern"), "temporary", "run", { ttl_ms: 60_000 });
    expect(res.status).toBe(201);
    const fact = (await (await get(h.stub("intern"), `/facts/${body.fact?.id}`)).json()) as {
      fact: { ttl: number };
    };
    expect(fact.fact.ttl).toBeGreaterThan(Date.now());
  });
});
