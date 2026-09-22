### Task 9 — memory MCP tools (4)
**Files:** `src/mcp-memory-tools.ts`, `test/mcp-memory-tools.test.ts`
- `registerMemoryTools(registry, env)`:
  `memory_recall(query, limit?)` (scope `memory:read`),
  `memory_bank(fact, source, ttl?)` (scope `memory:write`),
  `memory_forget(fact_id)` (scope `memory:write`),
  `memory_sessions(agent?)` (scope `memory:read`).
- Each routes to `Memory` DO + Vectorize; recall returns `{facts:[{id, fact,
  source, agent, score}]}` sorted desc.
- Tests: scope map, arg validation, recall join shape.

