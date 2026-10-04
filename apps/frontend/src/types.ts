// Shared run-record shapes for the dashboard workbench.
// Wire contracts come from @shiba/shared (the single source of truth the
// backend serves); genuinely UI-only or server-projected shapes stay local.
import type {
  AuditRow,
  DelegatedRun,
  DraftRecord,
  EmailDirection,
  MailboxRecord,
  PendingApproval,
  SessionRecord,
} from "@shiba/shared";

export type { EmailDirection } from "@shiba/shared";

/**
 * Retained run record from `GET /api/runs` — the orchestrator's
 * DelegatedRun verbatim. Aliased (not mirrored) so drift is impossible.
 */
export type RetainedRun = DelegatedRun;

export interface ToolRunPart {
  text?: string;
  delta?: string;
  message?: string;
  body?: string;
  [key: string]: unknown;
}

export interface ToolRunRecord {
  runId: string;
  status: string;
  agentType?: string;
  parentToolCallId?: string;
  parts: ToolRunPart[];
  summary?: string;
  error?: string;
  diff?: string;
  [key: string]: unknown;
}

// ---- Inbox + Memory DTOs (megaplan T11) ----
// Wire shapes of /api/mailboxes, /api/emails*, /api/threads/:id, /api/drafts*,
// and /api/memory/* — they mirror the Mailbox/Memory DO records; timestamps
// are epoch milliseconds.

/** `GET /api/mailboxes` serves MailboxRecord rows verbatim. */
export type InboxMailbox = MailboxRecord;

/**
 * Wire values of `StoredEmail.direction`. The email body route projects
 * StoredEmail with bodies optional + `mailbox` attached on fan-out routes —
 * a server-side projection, so this stays local rather than reusing
 * StoredEmail (whose body fields are non-optional `| null`).
 */
export interface InboxEmail {
  id: string;
  thread_id: string;
  direction: EmailDirection;
  from_addr: string;
  to_addr: string;
  subject: string;
  status: string;
  created_at: number;
  /** Owning mailbox, attached when a route fans out across mailboxes. */
  mailbox?: string;
  body_text?: string | null;
  body_html?: string | null;
}

/**
 * Pending-approval record from `GET /api/approvals` — the orchestrator's
 * PendingApproval verbatim (Slack-card approvals, queued email sends,
 * dashboard run approvals). `payload` is the frozen input that executes
 * on approve; `repoUrl`/`task` carry the human-readable summary.
 */
export type StoredApproval = PendingApproval;

/**
 * Registered MCP-token principal from `GET /api/agents` — one row per
 * principal name, aggregated across that name's token records. `live`
 * means at least one non-revoked token exists: the principal can
 * authenticate at `/mcp` right now. MCP calls are request-scoped, so
 * credential state is the closest connection state the worker can
 * observe — there is no persistent session to probe.
 */
export interface AgentPrincipal {
  principal: string;
  /** Union of scopes across the principal's tokens. */
  scopes: string[];
  /** Earliest token creation for this principal, epoch ms. */
  created: number;
  live: boolean;
}

/**
 * Attachment manifest row — a projection of StoredAttachment: the route
 * drops `r2_key` (internal bucket key) and `content_id`, so this stays
 * local rather than aliasing the shared record.
 */
export interface InboxAttachment {
  part_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number;
}

export interface InboxThread {
  id: string;
  subject: string;
  last_message_at: number;
  emails: InboxEmail[];
}

/**
 * Draft row from `/api/drafts*` — DraftRecord plus the owning `mailbox`
 * on fan-out routes.
 */
export interface InboxDraft extends DraftRecord {
  mailbox?: string;
}

/**
 * Recall result row — FactRecord projected by the route: `embedding_id`
 * and `ttl` are internal, `score` is added on recall results. Stays local.
 */
export interface MemoryFact {
  id: string;
  fact: string;
  source: string;
  agent: string;
  /** Present on recall results only — higher is a better match. */
  score?: number;
  created_at: number;
}

/** `GET /api/memory/sessions` serves SessionRecord rows verbatim. */
export type MemorySession = SessionRecord;

/**
 * Audit-log row from `GET /api/audit` (megaplan T13) — AuditRow verbatim:
 * one row per MCP tool call, `args_hash` is a SHA-256 fingerprint never
 * the args, `ts` is epoch ms.
 */
export type AuditEntry = AuditRow;

/** Merged tool + retained run shape used by the Diff surface's run list. */
export interface VMRun {
  runId: string;
  sandboxId: string;
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  status: string;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  error?: string;
  diff?: string;
}
