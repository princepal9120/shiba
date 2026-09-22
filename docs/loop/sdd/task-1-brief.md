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

