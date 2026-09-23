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

