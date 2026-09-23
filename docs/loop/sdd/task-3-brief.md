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

