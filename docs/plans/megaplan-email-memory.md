# Megaplan: Email Inbox + Long-term Memory + Dashboard UI

Spec authority: the user's megaplan message (email inbox via MailboxDO + Email Routing,
long-term memory via MemoryDO + Vectorize, MCP gateway with per-agent scoped tokens,
approval-gated destructive ops, dashboard Inbox/Memory/Approvals/Agents panels).
This file is the implementation plan argued from that spec.

## Context

ai-intern is a self-hosted Cloudflare Workers app (`src/index.ts`) with Durable
Objects (`CodingOrchestrator`, `OpenCodeAgent`, `Sandbox`, `Automations`) and a
Vite React dashboard (`src/dashboard/`). DO convention: thin DO class over a pure
store module (see `automations-do.ts` + `automations.ts`) so store logic is
vitest-testable without workerd. Deploy config is `wrangler.jsonc` — Alchemy was
evaluated (`docs/alchemy-effect-evaluation.md`) and not adopted; wire all new
bindings in `wrangler.jsonc`, not an alchemy file.

## Global Constraints

- **Deny by default**: every `/mcp` tool call requires a valid bearer token whose
  principal has the tool's scope. No token or missing scope → 401/JSON-RPC error.
- **Tokens**: stored SHA-256-hashed in KV (`AGENT_TOKENS`); the raw token value is
  returned exactly once at creation and never stored or logged.
- **Approval gate**: `send_email`, `send_reply`, `delete_email` never execute
  directly. They create a pending approval (existing `PendingApproval` flow +
  Slack card path in `slack-approval.ts`) and return `{approval_id, status:
  "pending_approval"}`. Auto-send is forbidden.
- **Prompt injection defense**: every email body returned to an agent is wrapped
  `{ untrusted: <body>, security_notice: "..." }` and link-flagged with
  `flags: ["private_ip" | "sender_mismatch" | "non_https"]` per link found.
- **Registered addresses only**: the `email()` handler drops mail whose recipient
  is not a registered mailbox; no catch-all processing.
- **Audit**: every MCP tool call writes `{principal, tool, args_hash, outcome,
  ts}` to the audit store (D1 `AGENT_AUDIT`, placeholder id until created).
- **Migrations**: new DO classes go in `wrangler.jsonc` `migrations` as
  `new_sqlite_classes` entries (learned B1 — not `new_classes`). Bump tags v3+.
- **Design system**: the megaplan text cites teal `#0B9F95` + Space Grotesk from
  `design.md`, but the dashboard has since been restyled to the Bezalel system
  (this branch's base). New panels MUST use the current tokens in
  `src/dashboard/styles.css`: cream `#f6f4ed`/`#fffef8`/`#f1efe6`, navy accent
  `#0000a8`, borders `#e0ded5`/`#d3d2c8`, text `#222320`, muted `#6a6f63`,
  status `#15803d`/`#f99c00`/`#b45309`/`#fb2c36`, fonts `font-display`
  (Instrument Serif) / `font-sans` (Geist) / `font-mono` (Geist Mono). Reuse
  `statusChipClass` and existing component conventions.
- **Checks**: every task must leave `pnpm typecheck && pnpm lint && pnpm test`
  green. New pure logic gets vitest coverage in `test/`.
- **Deps**: new dependencies must be pinned, published >7 days, and noted in the
  task report with reason. Target dep for MIME parsing: `postal-mime`.
- **Scope discipline**: implement only what the task says; do not restructure
  unrelated code.

## Interfaces between tasks

- `src/mailbox-store.ts` exports `MailboxStore` pure class + `StoredEmail`,
  `StoredThread`, `DraftRecord`, `MailboxRecord` types + `MAILBOX_SCHEMA` DDL.
- `src/mailbox-do.ts` exports DO class `Mailbox` (name it `Mailbox`), thin
  JSON-over-fetch surface calling MailboxStore; env binding name `Mailbox`.
- `src/email-handler.ts` exports `handleInboundEmail(message, env, ctx)` used by
  `index.ts`'s `email()` export.
- `src/agent-tokens.ts` exports `hashToken`, `createToken`, `verifyToken`,
  `requireScope(principal, scope)` against `env.AGENT_TOKENS` KV.
- `src/audit.ts` exports `audit(env, {principal, tool, argsHash, outcome})` →
  D1 `AGENT_AUDIT` insert (best-effort, never throws into the tool path).
- `src/mcp-gateway.ts` exports DO class `McpGateway` (extends `McpAgent` from
  `agents/mcp`), tool registry, scope check per tool, audit write per call.
- `src/mcp-email-tools.ts` / `src/mcp-memory-tools.ts` export tool registration
  functions called by the gateway.
- `src/memory-store.ts` + `src/memory-do.ts` mirror the mailbox pair; DO class
  `Memory`, binding `Memory`; Vectorize binding `MEMORY_VECTORS`.
- `src/email-approvals.ts` bridges email tools → `PendingApproval` records.
- Dashboard: `InboxTab.tsx`, `MemoryTab.tsx` under `src/dashboard/components/`;
  `WorkspaceTab` union extended `"inbox" | "memory"`; data routes under
  `/api/mailboxes`, `/api/emails`, `/api/memory`, `/api/audit` in `index.ts`,
  same Access-auth gate as `/api/runs`.

## Tasks

### Task 1 — mailbox store core (pure)
**Files:** `src/mailbox-store.ts`, `test/mailbox-store.test.ts`
- `MAILBOX_SCHEMA` DDL (per spec): `emails(id, thread_id, direction, from_addr,
  to_addr, subject, body_text, body_html, status, created_at)`,
  `threads(id, subject, last_message_at)`, `drafts(id, thread_id, to_addr,
  subject, body_text, status, created_at, updated_at)`, `mailboxes(address
  PRIMARY KEY, label, agent, created_at)`, FTS5 `emails_fts` content-linked.
- `MailboxStore` class operating on an injected `exec(sql, ...params)` fn (so it
  is testable without DO storage): addEmail, getEmail, getThread, listEmails
  (status/mailbox filters), searchEmails (FTS MATCH with quoted sanitization),
  createDraft/updateDraft/listDrafts, markRead, moveStatus, deleteEmail,
  registerMailbox/listMailboxes/isRegistered, threadFor (Message-ID/In-Reply-To/
  subject normalization fallback).
- Security helpers: `flagLinks(html|text)` → per-link flags
  (`private_ip` for RFC1918/localhost/169.254, `non_https`, `sender_mismatch`
  when anchor text shows a different domain than href); `wrapUntrusted(body,
  meta)` → `{untrusted, security_notice, link_flags}`.
- Tests cover: schema exec, CRUD, FTS search escaping, thread grouping, link
  flagging cases, untrusted wrap shape.

### Task 2 — MailboxDO
**Files:** `src/mailbox-do.ts`, `src/index.ts` (export + route), `wrangler.jsonc`,
`src/env.ts`, `test/mailbox-do.test.ts` (route-level if feasible, else store-level
already covered — document choice)
- `export class Mailbox` DO (plain class like `Automations`, `ctx.storage.sql`
  for SQLite), one stub per mailbox address (`idFromName(address)`).
- Internal JSON API via `fetch`: POST `/emails`, GET `/emails` (+query),
  `/emails/:id`, `/threads/:id`, `/emails/search?q=`, POST `/drafts`,
  PATCH `/drafts/:id`, POST `/emails/:id/read`, `/move`, DELETE `/emails/:id`,
  GET `/mailbox` meta. Worker routes under `/internal/mailbox/*` are internal
  (not Access-gated like user routes; not reachable externally).
- `wrangler.jsonc`: DO binding `Mailbox` + migration `{"tag":"v3",
  "new_sqlite_classes":["Mailbox"]}`; R2 bucket binding `ATTACHMENTS`
  (`bucket_name: "shiba-attachments"`); attachment bodies >256KB go to R2 keyed
  `emailId/partId`.
- Registered-address check on inbound: `isRegistered(to)`.

### Task 3 — inbound email handler
**Files:** `src/email-handler.ts`, `src/index.ts` (`email()` export),
`test/email-handler.test.ts`, `package.json` (`postal-mime` pin)
- `export async function email(message: ForwardableEmailMessage, env, ctx)` on
  the worker: parse via `postal-mime` (raw stream → parsed), resolve recipient →
  registered mailbox check → store via MailboxDO (from/to/subject/text/html,
  thread linking via headers), attachments → R2, drop+count unregistered.
- `setReject` path: unregistered recipient → `message.setReject("Unknown
  address")`; parse failure → store raw subject + flag, never crash.
- Tests: feed synthetic RFC822 strings through the handler logic with a stub
  store (pure boundary); unregistered drop, MIME quirks (multipart, base64,
  missing subject), attachment capture path.

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

### Task 6 — email MCP tools (13)
**Files:** `src/mcp-email-tools.ts`, `test/mcp-email-tools.test.ts`
- Register on gateway (signature: `registerEmailTools(registry, env)`):
  `list_mailboxes, list_emails(mailbox, status?, limit?), get_email(id),
  get_thread(thread_id), search_emails(query, mailbox?, limit?),
  create_draft(mailbox, to, subject, body, thread_id?), update_draft(draft_id,
  fields), draft_reply(email_id, body), send_email(draft_id|composed),
  send_reply(email_id, body), mark_email_read(id), move_email(id, status),
  delete_email(id)` — mirror agentic-inbox semantics.
- Scopes: `email:read` for list/get/search/mark, `email:draft` for create/
  update/draft_reply, `email:send` for send_*, `email:delete` for delete.
- send_*/delete_* do NOT execute: they call `queueEmailApproval` (T7 interface —
  define the import seam now with a typed function from `email-approvals.ts`;
  if T7 lands after T6, T6 may stub it as "not wired" returning approval_id via
  the seam — controller will order T7 before T6's review only if implementer
  prefers; simplest: T7 ships the module first). Read the plan ordering: T6 and
  T7 may swap if the implementer notes the seam; the contract is the queue
  function's signature `(env, {kind, mailbox, payload}) => {approval_id}`.
- Every email body in a tool response uses `wrapUntrusted` + link flags.
- Tests: scope mapping table, tool arg validation (zod), untrusted wrapping in
  responses, approval-path tools return `pending_approval` + id.

### Task 7 — email approval bridge
**Files:** `src/email-approvals.ts`, `src/pending-approvals.ts` (extend type),
`src/slack-approval.ts` (card copy for email kind), `src/agents/orchestrator.ts`
(resolve path), `test/email-approvals.test.ts`
- Extend `PendingApproval` with `kind: "run" | "email_send" | "email_delete"`
  (default "run" — backward compatible) and `payload?: JsonValue` holding the
  frozen send/delete input. `createPendingApproval` accepts the new fields.
- `queueEmailApproval(env, {kind, mailbox, payload})` → creates approval via the
  same orchestrator `/api/runs`→approvals path the automations use
  (`queueOnOrchestrator`-style internal fetch) so Slack cards + dashboard both
  pick it up. On resolve(approved) the orchestrator executes the frozen payload
  via MailboxDO / SendEmail binding (`env.SEND_EMAIL` for outbound — binding in
  wrangler, `type: "send_email"`, `destination_addresses` unset).
- Slack card text for email kind: "Agent X requests email send to Y: subject".
- Tests: approval record shape, resolve executes payload once (replay-guarded),
  rejection leaves draft unsent.

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

### Task 10 — session distillation on run end
**Files:** `src/agents/orchestrator.ts`, `src/session-distill.ts`,
`test/session-distill.test.ts`
- When a retained run reaches `completed`/`error`: `distillSession(env, run)`
  summarizes the run transcript via `env.AI.run(ORCHESTRATOR_MODEL, …)` into ≤10
  durable facts + one session summary, then `memory_bank` each via `Memory` DO
  and `addSession`. Behind env flag `MEMORY_ENABLED` (default on; "0"/"false"
  off). `ctx.waitUntil`, wrapped in try/catch — failure logs and never fails
  the run.
- Tests: distillation input shaping, disabled flag, failure isolation.

### Task 11 — dashboard Inbox + Memory tabs
**Files:** `src/dashboard/components/InboxTab.tsx`,
`src/dashboard/components/MemoryTab.tsx`,
`src/dashboard/components/WorkspacePanel.tsx`, `src/dashboard/types.ts`,
`src/dashboard/app.tsx`, `src/index.ts` (API routes),
`test/inbox-tab.test.ts` (or covered by existing dashboard tests)
- `WorkspaceTab` += `"inbox" | "memory"`; TABS += Inbox, Memory.
- API routes (Access-auth'd same as `/api/runs`): `GET /api/mailboxes`,
  `GET /api/emails?mailbox=&status=`, `GET /api/emails/:id`,
  `GET /api/threads/:id`, `GET /api/emails-search?q=`, `GET /api/drafts`,
  `POST /api/drafts/:id/send` (proxy → approval), `GET /api/memory/facts?q=`,
  `GET /api/memory/sessions`, `DELETE /api/memory/facts/:id`.
- InboxTab: mailbox dropdown, email rows (unread dot `#0000a8`/`#f99c00` per
  statusChipClass conventions, sender, subject truncate, time-ago mono),
  expandable row (body preview, thread link, "Draft reply" button), drafts
  section with `#f99c00` left border + Approve/Send action linking to
  Approvals tab.
- MemoryTab: search input → recall results list; fact rows (mono fact text,
  source badge — run/email/manual — age, forget button with confirm); sessions
  list (agent, date, expandable summary).
- Bezalel tokens only (see Global Constraints). Loading/empty/error states
  consistent with RunsTab.

### Task 12 — agents sidebar section + unified Approvals tab
**Files:** `src/dashboard/components/SessionsSidebar.tsx`,
`src/dashboard/components/WorkspacePanel.tsx` (Approvals section),
`src/dashboard/types.ts`, `src/dashboard/app.tsx`, `src/index.ts`
- `GET /api/agents` already exists — extend response to include registered
  agent principals (from token store list via internal route) + connection
  state; render an "Agents" group in SessionsSidebar below "Active": name,
  live dot, scope summary tooltip.
- Approvals tab: single list of all pending approvals (runs + email + any
  kind field), each card: agent name, tool/action, args preview, Approve /
  Reject wired to existing `/api/approvals` resolve path.

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
