### Task 5 — MCP gateway DO + /mcp route
**Files:** `src/mcp-gateway.ts`, `src/index.ts` (route + export),
`src/env.ts`, `wrangler.jsonc`, `test/mcp-gateway.test.ts`
- `export class McpGateway extends McpAgent` (from `agents/mcp`) as a Durable
  Object; binding `McpGateway`, migration v4 `new_sqlite_classes:["McpGateway"]`.
- `index.ts`: `/mcp` (and `/mcp/*`) → bearer auth via `verifyToken` before any
  MCP handling (no token → 401 JSON, NOT MCP error); attach principal to a
  per-request context the tool registry reads.
- `registerTool(name, scope, handler)` registry; each call wrapped:
  `requireScope` → `audit(...)` → result/error. Tool args are SHA-256-hashed for
  args_hash (canonical JSON stringify sorted keys).
- Principal is per-token; `principalFor(request)` helper exported for tests.
- Tests: 401 without token, 403-equivalent on missing scope, audit called with
  hashed args (no secret values in args_hash input? hash covers raw args — note
  in code comment that args_hash is a hash, never the args themselves).

