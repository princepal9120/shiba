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

