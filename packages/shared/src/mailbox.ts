/**
 * Mailbox wire DTOs — `GET /api/mailboxes`, `/api/emails*`,
 * `/api/threads/:id`, and `/api/drafts*` serve these verbatim
 * (snake_case, epoch-millisecond timestamps).
 */

export const EMAIL_STATUSES = ["unread", "read", "archived", "sent", "deleted"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_DIRECTIONS = ["inbound", "outbound"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];

export const DRAFT_STATUSES = ["draft", "queued", "sending", "sent", "discarded"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/**
 * Statuses a caller may set through a draft update: edits keep a draft
 * alive (`"draft"`) or abandon it (`"discarded"`). `"queued"`/`"sent"`
 * exist only as outcomes of the approval-gated send path — accepting them
 * here would let any draft-write caller mint fake evidence of a send for
 * tools/UI that read `drafts.status`.
 */
export const DRAFT_UPDATE_STATUSES = ["draft", "discarded"] as const;
export type DraftUpdateStatus = (typeof DRAFT_UPDATE_STATUSES)[number];

export interface StoredEmail {
  id: string;
  thread_id: string;
  direction: EmailDirection;
  from_addr: string;
  to_addr: string;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  status: EmailStatus;
  /** Epoch milliseconds. */
  created_at: number;
}

export interface StoredThread {
  id: string;
  /** Normalized subject. */
  subject: string;
  last_message_at: number;
}

export interface ThreadView extends StoredThread {
  emails: StoredEmail[];
}

export interface DraftRecord {
  id: string;
  thread_id: string | null;
  to_addr: string;
  subject: string;
  body_text: string;
  status: DraftStatus;
  /**
   * Internal id of the email this draft replies to — carried on the row
   * so a frozen approval payload keeps wire threading (`In-Reply-To`/
   * `References`) no matter which send path releases it.
   */
  in_reply_to_email_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface MailboxRecord {
  address: string;
  label: string | null;
  agent: string | null;
  created_at: number;
}

/** One row of an email's attachment manifest — metadata only; bodies are in R2. */
export interface StoredAttachment {
  part_id: string;
  filename: string | null;
  mime_type: string | null;
  /** Decoded body size in bytes. */
  size: number;
  content_id: string | null;
  /** Object key inside the `ATTACHMENTS` bucket (`emailId/partId`). */
  r2_key: string;
}
