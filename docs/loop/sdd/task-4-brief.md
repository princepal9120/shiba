### Task 4 — agent token store + audit writer
**Files:** `src/agent-tokens.ts`, `src/audit.ts`, `src/env.ts`,
`wrangler.jsonc`, `test/agent-tokens.test.ts`, `test/audit.test.ts`
- Token record in KV `AGENT_TOKENS`: `{principal, scopes[], created, revoked}`;
  stored under key `tok_<sha256hex>`; raw token only at creation.
- `createToken(env, principal, scopes)` → `{token: "shb_<id>_<secret>", record}`;
  `verifyToken(env, bearer)` → principal record or null; `revokeToken`.
- `SCOPES` constant + `requireScope(record, scope)`; scope list:
  `email:read email:draft email:send email:delete memory:read memory:write
  sandbox:exec admin:tokens`.
- `audit(env, entry)` → D1 `AGENT_AUDIT` (`audit_log` table: id, ts, principal,
  tool, args_hash sha256, outcome, detail); `initAudit` creates table if missing;
  write is fire-and-forget safe (try/catch + console.warn).
- `wrangler.jsonc`: KV `AGENT_TOKENS` (placeholder `id`), D1 `AGENT_AUDIT`
  (placeholder `database_id` + comment noting `wrangler d1 create` needed).
- Tests: hash determinism, verify/revoke, scope checks, audit insert stub.

