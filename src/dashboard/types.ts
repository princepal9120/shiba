// Shared run-record shapes for the dashboard workbench.
// Single source of truth — app.tsx, WorkspacePanel, and future panes import
// these instead of redeclaring them.
export interface RetainedRun {
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

export interface InboxMailbox {
  address: string;
  label: string | null;
  agent: string | null;
  created_at: number;
}

/** Wire values of `StoredEmail.direction` — mirrors EMAIL_DIRECTIONS. */
export type EmailDirection = "inbound" | "outbound";

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
 * Pending-approval record from `GET /api/approvals` — the orchestrator
 * DO's live pointer list (Slack-card approvals, queued email sends,
 * dashboard run approvals). `payload` is the frozen input that executes
 * on approve; `repoUrl`/`task` carry the human-readable summary.
 */
export interface StoredApproval {
  threadKey: string;
  approvalId: string;
  repoUrl: string;
  task: string;
  status: string;
  createdAt: number;
  kind?: string;
  payload?: unknown;
  baseBranch?: string;
  publishPullRequest?: boolean;
  /** Decision wall-clock — set once the pointer resolves. */
  decidedAt?: number;
  decidedBy?: string;
  /** Executor outcome for email-kind approvals (`executed` / `failed` + error). */
  execution?: {
    status: string;
    error?: string;
    executedAt: number;
  };
}

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

export interface InboxDraft {
  id: string;
  thread_id: string | null;
  to_addr: string;
  subject: string;
  body_text: string;
  status: string;
  in_reply_to_email_id: string | null;
  created_at: number;
  updated_at: number;
  mailbox?: string;
}

export interface MemoryFact {
  id: string;
  fact: string;
  source: string;
  agent: string;
  /** Present on recall results only — higher is a better match. */
  score?: number;
  created_at: number;
}

export interface MemorySession {
  id: string;
  agent: string;
  started_at: number;
  summary: string;
}

/**
 * Audit-log row from `GET /api/audit` (megaplan T13) — one per MCP tool
 * call. `args_hash` is a SHA-256 fingerprint of the args, never the args
 * themselves, so the table can show it verbatim. `ts` is epoch ms.
 */
export interface AuditEntry {
  id: string;
  ts: number;
  principal: string;
  tool: string;
  args_hash: string;
  outcome: string;
  detail: string | null;
}
