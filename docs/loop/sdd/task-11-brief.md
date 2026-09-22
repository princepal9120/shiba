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

