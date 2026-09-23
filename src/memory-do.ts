/**
 * Memory Durable Object (megaplan task 8): thin JSON-over-fetch surface over
 * {@link MemoryStore} on `ctx.storage.sql`, plus the Workers AI embedding and
 * Vectorize index calls that turn `bank`/`recall` into semantic memory.
 *
 * Instance model: one stub per agent name (`env.Memory.idFromName(agent)`)
 * owns that agent's `facts`. The reserved `global` stub
 * (`idFromName(MEMORY_REGISTRY_NAME)`) owns `fact_registry` — one row per
 * fact mapping id → owning agent — and `sessions`, the cross-agent run log.
 * `bank` on an agent stub inserts the fact row, claims the fact id on
 * `global` (the single serialization point for cross-agent uniqueness —
 * a foreign owner conflicts the write before any vector lands), then
 * upserts a bge-base 768-dim vector keyed by the fact id.
 * `recall` (`GET /facts/search`) embeds the query, queries `MEMORY_VECTORS`,
 * and joins each hit back to its owning agent stub through the registry.
 * Forget and TTL purge drop all three copies — row, vector, registry row —
 * and the registry's self-heal unregisters (a vanished fact behind an
 * index row) drop the vector too, so the index never accumulates
 * un-joinable orphans.
 *
 * All routes live under `/internal/memory/*` and are reachable only through
 * `stub.fetch` inside the worker — index.ts returns 404 for external
 * `/internal/*` paths, so none of this is a public surface.
 */
import type { Env } from "./env.js";
import {
  MAX_LIST_LIMIT,
  MemoryStore,
  randomHex,
  type FactRecord,
  type SqlExec,
  type SqlRow,
} from "./memory-store.js";
import { InputError } from "./security.js";

/** Reserved DO name for the shared registry + sessions instance. */
export const MEMORY_REGISTRY_NAME = "global";

const ROUTE_PREFIX = "/internal/memory";

/** Spec embedding model — 768-dim output, cosine index. */
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5" as const;
const EMBEDDING_DIMS = 768;

/** Vectorize's documented `topK` ceiling (no values/metadata requested). */
const MAX_RECALL_TOP_K = 100;

/** Per-agent stub — the unit every fact write/scoped read goes through. */
export function memoryStub(env: Env, agent: string): DurableObjectStub {
  return env.Memory.get(env.Memory.idFromName(agent.trim()));
}

/** Shared registry stub — cross-agent reads route through `global` (T8). */
export function memoryRegistryStub(env: Env): DurableObjectStub {
  return memoryStub(env, MEMORY_REGISTRY_NAME);
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function notFound(what = "Not found."): Response {
  return json({ error: what }, { status: 404 });
}

function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

/** Cross-agent fact-id collision — bank maps this to a 409, not a 500. */
class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`${field} must be a non-empty string.`);
  }
  return value;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Path segment decode — a malformed %escape is a 400, not a 500. */
function pathParam(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    throw new InputError("Path parameter is not valid percent-encoding.");
  }
}

function limitParam(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  // Non-numeric input must not reach `slice`/`LIMIT` or fan out to agent
  // stubs as `?limit=NaN` — reject it as a 400 like `/facts/search` does.
  if (raw.trim() === "" || !Number.isFinite(value)) {
    throw new InputError("limit must be a number.");
  }
  return value;
}

/**
 * `limit` bound for the Vectorize `topK` in {@link Memory.recall}. Store
 * reads sanitize via `clampLimit`, but a malformed value here would go
 * straight to the Vectorize API and surface as a 500 — reject it as a 400.
 */
function topKParam(raw: string | null): number | undefined {
  const value = limitParam(raw);
  // Anything above the index's topK ceiling errors inside Vectorize (a 500)
  // and would fan out one fact fetch per match — reject it up front.
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 1 || value > MAX_RECALL_TOP_K)
  ) {
    throw new InputError(
      `limit must be a positive integer no greater than ${MAX_RECALL_TOP_K}.`,
    );
  }
  return value;
}

/** Fact JSON carries the owning agent — facts rows have no column for it. */
function factJson(fact: FactRecord, agent: string): Record<string, unknown> {
  return { ...fact, agent };
}

export class Memory {
  private readonly store: MemoryStore;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    const exec: SqlExec = (sql, ...params) =>
      ctx.storage.sql.exec(sql, ...params).toArray() as unknown as SqlRow[];
    this.store = new MemoryStore(exec);
    ctx.blockConcurrencyWhile(async () => {
      this.store.init();
    });
  }

  /** The `idFromName` input this stub was created with ("" for unique ids). */
  private get agent(): string {
    return this.ctx.id.name ?? "";
  }

  private get isRegistry(): boolean {
    return this.agent === MEMORY_REGISTRY_NAME;
  }

  private async jsonBody(request: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new InputError("Request body is not valid JSON.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new InputError("Request body must be a JSON object.");
    }
    return body as Record<string, unknown>;
  }

  // -- embedding + vector index -------------------------------------------------

  /** Embed text to a 768-dim vector via Workers AI (bge-base-en-v1.5). */
  private async embed(text: string): Promise<number[]> {
    const result = await this.env.AI.run(EMBEDDING_MODEL, { text });
    // Known-model overload returns `{data?: number[][]} | {request_id}`.
    const data = (result as { data?: number[][] }).data;
    const vector = data?.[0];
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMS) {
      throw new Error(
        `Embedding failed: ${EMBEDDING_MODEL} did not return a ${EMBEDDING_DIMS}-dim vector.`,
      );
    }
    return vector;
  }

  private async upsertVector(factId: string, agent: string, values: number[]): Promise<void> {
    // `agent` rides as metadata so recall can scope the query to one agent.
    await this.env.MEMORY_VECTORS.upsert([{ id: factId, values, metadata: { agent } }]);
  }

  private async deleteVector(factId: string): Promise<void> {
    // Best-effort: a failed vector delete leaves one un-joinable id — the
    // registry lookup for recall/delete already returned absent.
    try {
      await this.env.MEMORY_VECTORS.deleteByIds([factId]);
    } catch (error) {
      console.warn(
        `memory_vector_delete_failed ${JSON.stringify({
          factId,
          error: error instanceof Error ? error.message : String(error),
        })}`,
      );
    }
  }

  /**
   * Register `factId -> agent` on the global stub. A failed write is fatal
   * to the bank: the fact row would exist but be invisible to cross-agent
   * recall and the dashboard's unfiltered fact list.
   */
  private async registerFact(factId: string, agent: string): Promise<void> {
    const res = await memoryRegistryStub(this.env).fetch(
      new Request(`https://internal${ROUTE_PREFIX}/registry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fact_id: factId, agent }),
      }),
    );
    // 409 means another agent owns this id — a conflict for the caller,
    // not a transport failure: bank maps it to a 409 of its own.
    if (res.status === 409) {
      throw new ConflictError(`Fact "${factId}" is already banked by another agent.`);
    }
    if (!res.ok) {
      throw new Error(`Memory registry write failed (${res.status}).`);
    }
  }

  /**
   * Drop `factId` from the global registry — best-effort like
   * {@link deleteVector}: a missed row is invisible to recall (the join
   * skips orphans) and self-heals on the next registry `GET /facts/:id`.
   */
  private async dropRegistryEntry(factId: string): Promise<void> {
    try {
      const res = await memoryRegistryStub(this.env).fetch(
        new Request(
          `https://internal${ROUTE_PREFIX}/registry/${encodeURIComponent(factId)}`,
          { method: "DELETE" },
        ),
      );
      if (!res.ok) {
        console.warn(
          `memory_registry_unregister_failed ${JSON.stringify({ factId, status: res.status })}`,
        );
      }
    } catch (error) {
      console.warn(
        `memory_registry_unregister_failed ${JSON.stringify({
          factId,
          error: error instanceof Error ? error.message : String(error),
        })}`,
      );
    }
  }

  /**
   * `purgeExpiredFacts` deletes TTL-dead rows inside every store read and
   * returns their ids — each purged fact still owns a Vectorize vector and
   * a registry row on `global`. Drop both so the index and
   * `listRegisteredAgents` never accumulate orphans.
   */
  private async collectPurged(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.deleteVector(id);
      if (this.isRegistry) {
        this.store.unregisterFact(id);
      } else {
        await this.dropRegistryEntry(id);
      }
    }
  }

  // -- routes -------------------------------------------------------------

  /**
   * `POST /facts` — bank one fact on this agent's stub: embed the text,
   * insert the row, claim the fact id on the global registry (the single
   * serialization point for cross-agent uniqueness — a conflict aborts
   * before the vector upsert can shadow another agent's fact), then
   * upsert the vector (id = fact id). Failure rolls back whatever was
   * written so a retried bank cannot create an unindexed orphan.
   */
  private async bank(request: Request): Promise<Response> {
    if (this.isRegistry) {
      return badRequest(
        `bank targets a per-agent instance, not ${MEMORY_REGISTRY_NAME}.`,
      );
    }
    const body = await this.jsonBody(request);
    const factText = requiredString(body.fact, "fact");
    const source = requiredString(body.source, "source");
    // `ttl` is the spec's epoch-ms deadline; `ttl_ms` is the caller-friendly
    // duration form — a deadline of `now + ttl_ms`.
    let ttl = optNumber(body.ttl) ?? null;
    const ttlMs = optNumber(body.ttl_ms);
    if (ttlMs !== undefined) {
      if (ttlMs <= 0) {
        throw new InputError("ttl_ms must be positive.");
      }
      ttl = Date.now() + ttlMs;
    }

    // The fact id is minted here so it doubles as the Vectorize id — the
    // row's `embedding_id` records it without a follow-up UPDATE. A
    // caller-supplied id must stay routable: "search" would shadow
    // `/facts/search`, and a "/" splits into extra route segments.
    let factId: string;
    if (body.id !== undefined) {
      const id = requiredString(body.id, "id");
      if (id === "search" || id.includes("/")) {
        throw new InputError(`id "${id}" collides with the /facts/:id route.`);
      }
      await this.collectPurged(this.store.purgeExpiredFacts());
      if (this.store.getFact(id) !== null) {
        return json({ error: `Fact "${id}" already exists.` }, { status: 409 });
      }
      factId = id;
    } else {
      factId = `fact_${randomHex(12)}`;
    }
    const vector = await this.embed(factText);
    const fact = this.store.bankFact({
      fact: factText,
      source,
      ttl,
      id: factId,
      embedding_id: factId,
    });
    // Claim the id on the registry before touching the index: a 409 means
    // another agent owns it — the local row rolls back and no vector write
    // happens, so the existing fact's vector is never clobbered.
    try {
      await this.registerFact(fact.id, this.agent);
    } catch (error) {
      this.store.forgetFact(fact.id);
      throw error;
    }
    try {
      await this.upsertVector(fact.id, this.agent, vector);
    } catch (error) {
      this.store.forgetFact(fact.id);
      await this.dropRegistryEntry(fact.id);
      throw error;
    }
    return json({ fact: factJson(fact, this.agent) }, { status: 201 });
  }

  /** This stub's live facts, newest first. */
  private async listFacts(url: URL): Promise<Response> {
    const limit = limitParam(url.searchParams.get("limit"));
    await this.collectPurged(this.store.purgeExpiredFacts());
    return json({ facts: this.store.listFacts({ limit }).map((f) => factJson(f, this.agent)) });
  }

  /**
   * `GET /facts/search` — recall: embed the query, `topK` the Vectorize
   * index, then join each hit to its fact row through the owning agent's
   * stub (via the global registry for cross-agent calls).
   */
  private async recall(url: URL): Promise<Response> {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query === "") {
      throw new InputError("q must be a non-empty string.");
    }
    const topK = topKParam(url.searchParams.get("limit"));
    const scopedAgent = this.isRegistry ? url.searchParams.get("agent")?.trim() || undefined : this.agent;
    await this.collectPurged(this.store.purgeExpiredFacts());
    const vector = await this.embed(query);
    const matches = await this.env.MEMORY_VECTORS.query(vector, {
      ...(topK !== undefined ? { topK } : {}),
      // Metadata filter keeps a scoped recall inside one agent's bankings —
      // the live index needs `wrangler vectorize create-metadata-index
      // shiba-memory --property-name=agent --type=string` (wrangler.jsonc).
      ...(scopedAgent !== undefined ? { filter: { agent: scopedAgent } } : {}),
    });
    const hits: Array<Record<string, unknown>> = [];
    for (const match of matches.matches) {
      const factId = match.id;
      if (!this.isRegistry) {
        // Agent stub — the scoped query only returns this stub's own rows.
        const fact = this.store.getFact(factId);
        if (fact !== null) {
          hits.push({ ...factJson(fact, this.agent), score: match.score });
        } else {
          // Orphaned vector — collect it (and the registry row pointing
          // here) exactly like `forget`, or it burns a topK slot on every
          // subsequent scoped recall.
          await this.deleteVector(factId);
          await this.dropRegistryEntry(factId);
        }
        continue;
      }
      const agent = this.store.factOwner(factId);
      if (agent === null) {
        // Orphaned vector — the fact was forgotten without the index row
        // (or vice versa). Collect it rather than just skipping: an
        // orphan keeps matching every recall and burns a topK slot.
        await this.deleteVector(factId);
        continue;
      }
      // One sequential stub fetch per hit — bounded by MAX_RECALL_TOP_K
      // (≤100 subrequests); the plan deliberately keeps this join simple.
      let fact: FactRecord | null;
      try {
        fact = await this.fetchFact(agent, factId);
      } catch (error) {
        // Same skip policy as the orphan above: one unresponsive agent
        // stub must not turn the whole cross-agent recall into a 500.
        console.warn(
          `memory_recall_fetch_failed ${JSON.stringify({
            factId,
            agent,
            error: error instanceof Error ? error.message : String(error),
          })}`,
        );
        continue;
      }
      if (fact === null) {
        // Registry pointed at a vanished row — same self-heal as the
        // GET path: drop the stale index entry and the orphaned vector.
        this.store.unregisterFact(factId);
        await this.deleteVector(factId);
        continue;
      }
      hits.push({ ...factJson(fact, agent), score: match.score });
    }
    hits.sort((a, b) => Number(b.score) - Number(a.score));
    return json({ facts: hits });
  }

  /** Fetch one fact row from an owning agent stub; null when absent. */
  private async fetchFact(agent: string, factId: string): Promise<FactRecord | null> {
    const res = await memoryStub(this.env, agent).fetch(
      new Request(`https://internal${ROUTE_PREFIX}/facts/${encodeURIComponent(factId)}`),
    );
    if (res.status === 404) {
      return null;
    }
    // Still throws on non-404 — callers decide whether a stub failure is
    // fatal (single-fact GET) or a skipped hit (cross-agent recall).
    if (!res.ok) {
      throw new Error(`Memory fact lookup failed (${res.status}).`);
    }
    const body = (await res.json()) as { fact?: FactRecord };
    return body.fact ?? null;
  }

  private async facts(request: Request, url: URL, seg: string[]): Promise<Response> {
    if (seg.length === 1) {
      if (request.method === "GET") {
        return await this.listFactsFor(url);
      }
      if (request.method === "POST") {
        return await this.bank(request);
      }
      return json({ error: "Method not allowed." }, { status: 405 });
    }
    if (seg.length === 2 && seg[1] === "search") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      return await this.recall(url);
    }
    const id = pathParam(seg[1]);
    if (seg.length === 2) {
      if (request.method === "GET") {
        if (!this.isRegistry) {
          await this.collectPurged(this.store.purgeExpiredFacts());
          const fact = this.store.getFact(id);
          return fact ? json({ fact: factJson(fact, this.agent) }) : notFound("Fact not found.");
        }
        const agent = this.store.factOwner(id);
        if (agent === null) {
          return notFound("Fact not found.");
        }
        const fact = await this.fetchFact(agent, id);
        if (fact === null) {
          // Registry pointed at a vanished row — drop the stale index
          // entry and the orphaned vector, or both accumulate un-GC'd.
          this.store.unregisterFact(id);
          await this.deleteVector(id);
          return notFound("Fact not found.");
        }
        return json({ fact: factJson(fact, agent) });
      }
      if (request.method === "DELETE") {
        return await this.forget(id);
      }
      return json({ error: "Method not allowed." }, { status: 405 });
    }
    return notFound();
  }

  /**
   * `GET /facts` on the registry fans out: `?agent=` proxies that stub's
   * list; no agent merges every registered agent's facts. On a per-agent
   * stub the route answers the local listing directly. The merge applies
   * `limit` as one global cap (default: the store's list ceiling) —
   * per-stub fetches ask for that same bound, or an agent holding more
   * than the store's single-stub default silently under-reports.
   */
  private async listFactsFor(url: URL): Promise<Response> {
    const limit = limitParam(url.searchParams.get("limit"));
    const scoped = url.searchParams.get("agent")?.trim();
    if (!this.isRegistry) {
      return this.listFacts(url);
    }
    // A row whose agent is the registry's own name would make this stub
    // fetch itself — the reserved name is never a valid scope or owner.
    if (scoped === MEMORY_REGISTRY_NAME) {
      throw new InputError(`agent must not be "${MEMORY_REGISTRY_NAME}".`);
    }
    const registered = this.store.listRegisteredAgents();
    // idFromName instantiates a DO for any string — scoping to a name that
    // has never banked would mint an empty stub at unbounded cardinality
    // (the same hazard resolveRegisteredMailbox guards on mailbox routes).
    // Only registered agents can own facts, so an unknown scope is an
    // empty result, not a stub probe.
    const agents = scoped ? (registered.includes(scoped) ? [scoped] : []) : registered;
    // One bound for the fan-out and the merge: without a caller limit the
    // cap is the store's own list ceiling (a single stub clamps there
    // anyway); with one, per-stub top-`limit` still covers the global
    // top-`limit` — no agent can occupy more than `limit` merged slots.
    const cap = limit ?? MAX_LIST_LIMIT;
    const facts: Record<string, unknown>[] = [];
    for (const agent of agents) {
      const res = await memoryStub(this.env, agent).fetch(
        new Request(`https://internal${ROUTE_PREFIX}/facts?limit=${cap}`),
      );
      if (!res.ok) {
        throw new Error(`Memory fact listing for ${agent} failed (${res.status}).`);
      }
      const body = (await res.json()) as { facts?: Record<string, unknown>[] };
      facts.push(...(body.facts ?? []));
    }
    facts.sort((a, b) => Number(b.created_at) - Number(a.created_at));
    return json({ facts: facts.slice(0, cap) });
  }

  /**
   * `DELETE /facts/:id` — on an agent stub: row + vector. On the registry:
   * resolve the owner through `fact_registry`, delegate the row delete to
   * that stub, and drop the index row so recall stops surfacing it.
   */
  private async forget(id: string): Promise<Response> {
    if (!this.isRegistry) {
      if (!this.store.forgetFact(id)) {
        return notFound("Fact not found.");
      }
      await this.deleteVector(id);
      await this.dropRegistryEntry(id);
      return json({ ok: true, id });
    }
    const agent = this.store.factOwner(id);
    if (agent === null) {
      return notFound("Fact not found.");
    }
    const res = await memoryStub(this.env, agent).fetch(
      new Request(`https://internal${ROUTE_PREFIX}/facts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );
    if (res.ok || res.status === 404) {
      // A 404 means the row vanished out from under the index — either way
      // the fact is gone, so the registry row goes too. A 5xx keeps the
      // index row so a retry can still find the owner.
      this.store.unregisterFact(id);
      if (res.status === 404) {
        // The agent-side delete never ran, so its vector cleanup never
        // happened either — drop it here to keep the index collectable.
        await this.deleteVector(id);
        return notFound("Fact not found.");
      }
      return json({ ok: true, id });
    }
    throw new Error(`Memory forget on agent ${agent} failed (${res.status}).`);
  }

  /** Sessions live only on the registry — writes elsewhere land nowhere. */
  private async sessions(request: Request, url: URL, seg: string[]): Promise<Response> {
    if (!this.isRegistry) {
      return badRequest(
        `Sessions are served by the ${MEMORY_REGISTRY_NAME} instance.`,
      );
    }
    if (seg.length !== 1) {
      return notFound();
    }
    if (request.method === "GET") {
      const agent = url.searchParams.get("agent")?.trim() || undefined;
      const limit = limitParam(url.searchParams.get("limit"));
      return json({ sessions: this.store.listSessions({ agent, limit }) });
    }
    if (request.method === "POST") {
      const body = await this.jsonBody(request);
      // Same contract as bank(): a non-string caller id is a 400, not a
      // silently auto-generated one.
      const id = body.id === undefined ? undefined : requiredString(body.id, "id");
      const agent = requiredString(body.agent, "agent").trim();
      // The reserved registry name is not a valid session owner — a
      // "global" row would answer ?agent=global with registry-owned rows
      // that no agent stub backs.
      if (agent === MEMORY_REGISTRY_NAME) {
        throw new InputError(`agent must not be "${MEMORY_REGISTRY_NAME}".`);
      }
      // Same contract as bank(): a caller id that already exists is a 409,
      // not a UNIQUE-constraint error surfacing as a 500.
      if (id !== undefined && this.store.getSession(id) !== null) {
        return json({ error: `Session "${id}" already exists.` }, { status: 409 });
      }
      const session = this.store.addSession({
        agent,
        summary: requiredString(body.summary, "summary"),
        started_at: optNumber(body.started_at),
        id,
      });
      return json({ session }, { status: 201 });
    }
    return json({ error: "Method not allowed." }, { status: 405 });
  }

  /**
   * `/registry` — `POST` indexes a banked fact, `GET` lists registered
   * agents, `DELETE /registry/:factId` drops an entry (forget, TTL purge).
   */
  private async registry(request: Request, seg: string[]): Promise<Response> {
    if (!this.isRegistry) {
      return badRequest(
        `The fact registry is served by the ${MEMORY_REGISTRY_NAME} instance.`,
      );
    }
    if (seg.length === 1) {
      if (request.method === "GET") {
        return json({ agents: this.store.listRegisteredAgents() });
      }
      if (request.method === "POST") {
        const body = await this.jsonBody(request);
        const agent = requiredString(body.agent, "agent").trim();
        // The reserved registry name as an owner routes /facts?agent= and
        // DELETE /facts/:id back to this stub — self-recursive fetches.
        if (agent === MEMORY_REGISTRY_NAME) {
          throw new InputError(`agent must not be "${MEMORY_REGISTRY_NAME}".`);
        }
        const factId = requiredString(body.fact_id, "fact_id");
        // Re-registering your own id is the at-least-once bank replay;
        // a different agent claiming it is a cross-agent collision — the
        // bare fact id keys the Vectorize vector, so an overwrite would
        // shadow the original fact in recall and registry-scoped delete.
        const owner = this.store.factOwner(factId);
        if (owner !== null && owner !== agent) {
          return json(
            { error: `Fact "${factId}" is already banked by another agent.` },
            { status: 409 },
          );
        }
        const entry = this.store.registerFact({ fact_id: factId, agent });
        return json({ entry }, { status: 201 });
      }
      return json({ error: "Method not allowed." }, { status: 405 });
    }
    if (seg.length === 2) {
      if (request.method !== "DELETE") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      const factId = pathParam(seg[1]);
      return json({ ok: true, id: factId, removed: this.store.unregisterFact(factId) });
    }
    return notFound();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      return notFound();
    }
    const seg = url.pathname
      .slice(ROUTE_PREFIX.length)
      .split("/")
      .filter((s) => s !== "");
    try {
      if (seg[0] === "facts") {
        return await this.facts(request, url, seg);
      }
      if (seg[0] === "sessions") {
        return await this.sessions(request, url, seg);
      }
      if (seg[0] === "registry") {
        return await this.registry(request, seg);
      }
      return notFound();
    } catch (error) {
      if (error instanceof InputError) {
        return badRequest(error.message);
      }
      if (error instanceof ConflictError) {
        return json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
  }
}
