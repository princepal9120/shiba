### Task 8 — memory store + MemoryDO
**Files:** `src/memory-store.ts`, `src/memory-do.ts`, `wrangler.jsonc`,
`src/env.ts`, `test/memory-store.test.ts`
- `MEMORY_SCHEMA`: `facts(id, fact, source, embedding_id, created_at, ttl)`,
  `sessions(id, agent, started_at, summary)`.
- `MemoryStore` pure class on injected exec; bankFact, getFact, listFacts
  (agent?, ttl-purge on read: `ttl` epoch-ms, NULL durable), forgetFact,
  addSession/listSessions.
- `export class Memory` DO, one stub per agent name (`idFromName(agent)`),
  JSON fetch API mirroring mailbox. Embedding: `env.AI.run("@cf/baai/
  bge-base-en-v1.5", {text})` → 768-dim; Vectorize `MEMORY_VECTORS`
  (`index_name: "shiba-memory"`, comment noting `wrangler vectorize create`
  needed). `bank` = insert fact row + upsert vector (id = fact id); `recall` =
  embed query → `MEMORY_VECTORS.query(vector, {topK})` → join fact rows
  (cross-agent: query returns fact ids across agents; look each up by global
  fact registry DO `idFromName("global")` holding an id→agent index — keep it
  simple: global registry row per fact).
- Tests: store CRUD, TTL purge, registry index; embedding calls mocked.

