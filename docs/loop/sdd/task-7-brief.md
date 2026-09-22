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

