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

export interface InboxEmail {
  id: string;
  thread_id: string;
  direction: string;
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
