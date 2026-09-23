### Task 13 — audit view + retention
**Files:** `src/index.ts` (`GET /api/audit`), `src/dashboard/components/
WorkspacePanel.tsx` or new `AuditPanel.tsx` section inside Approvals tab,
`test/audit-route.test.ts`
- `GET /api/audit?limit=&principal=` → D1 query (newest first, cap 200).
- Approvals tab gains an "Audit log" section: table of ts / principal / tool /
  outcome / args_hash (truncated), mono font, muted colors.
- Retention note in code comment: prune `audit_log` older than 90d in the cron
  trigger already in `wrangler.jsonc` (`scheduled` handler) — implement the
  prune inside the existing scheduled handler.

## Deploy-time dependencies (triage — NOT code blockers)

Recorded in `docs/loop/STATE.md` triage inbox. Code ships with placeholders:
- `wrangler d1 create shiba-audit` → paste `database_id` (placeholder `__PENDING__`)
- `wrangler kv namespace create AGENT_TOKENS` → paste id
- `wrangler r2 bucket create shiba-attachments`
- `wrangler vectorize create shiba-memory --dimensions=768 --metric=cosine`
- Enable Email Routing on the domain → route to this worker (MX setup is user-side)
- Enable Email Sending for `send_email` binding (account-dependent; if
  unavailable, T7 keeps sends approval-queued and reports the gap)
- `wrangler deploy` is outward-facing → user approval per loop rules
- Choose + register agent mailbox addresses
