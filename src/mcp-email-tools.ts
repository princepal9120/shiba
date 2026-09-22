/**
 * Email MCP tools (megaplan task 6): the thirteen-tool agentic-inbox
 * surface registered on the gateway's {@link ToolRegistry}.
 *
 * Routing: one `Mailbox` DO stub per registered address owns that
 * mailbox's emails/threads/drafts; the reserved directory instance owns
 * the registry. Tools naming a mailbox go straight to its stub. Tools
 * keyed by bare id can't know the owning stub (ids are random
 * `eml-`/`drf-`/`thr-` hex), so they resolve it by listing registered
 * mailboxes and probing every stub in parallel — a wrong stub 404s
 * without touching data, and id collisions across instances are
 * impossible, so the single 2xx hit is authoritative.
 *
 * Two megaplan constraints bind every response:
 * - Prompt-injection wrapping: any received email body goes back through
 *   {@link wrapUntrusted} (untrusted text + security notice + per-link
 *   flags). List/search rows carry no body at all.
 * - Approval gate: `send_email`, `send_reply`, and `delete_email` never
 *   execute — they freeze the request into {@link queueEmailApproval}
 *   and answer `pending_approval`. The T7 executor releases the frozen
 *   payload verbatim; callers can't rewrite it at release time.
 *
 * `move_email` maps to `email:draft`, the mailbox write scope: it
 * mutates `emails.status` inside the owning store — including the
 * `deleted` trash marker and a forgeable `sent` — so a read-only
 * principal must not hold it, while `delete_email` remains the
 * approval-gated hard delete.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Scope } from "./agent-tokens.js";
import { queueEmailApproval } from "./email-approvals.js";
import type { Env } from "./env.js";
import { mailboxDirectoryStub, mailboxStub } from "./mailbox-do.js";
import {
  DRAFT_UPDATE_STATUSES,
  EMAIL_STATUSES,
  wrapUntrusted,
  type DraftRecord,
  type MailboxRecord,
  type StoredAttachment,
  type StoredEmail,
  type ThreadView,
} from "./mailbox-store.js";
import type { ToolRegistry } from "./mcp-gateway.js";
import { InputError } from "./security.js";

/** Matches the `ROUTE_BASE` convention the inbound handler uses for stub.fetch. */
const ROUTE_BASE = "https://internal/internal/mailbox";

const MAX_LIMIT = 500;
const limitField = z.number().int().min(0).max(MAX_LIMIT).optional();
const idField = z.string().min(1);
const mailboxField = z.string().min(1);
const emailStatusField = z.enum(EMAIL_STATUSES);

// ---------------------------------------------------------------------------
// DO plumbing
// ---------------------------------------------------------------------------

interface StubTarget {
  /** `null` = the shared registry instance. */
  mailbox: string | null;
}

function stubFor(env: Env, target: StubTarget): DurableObjectStub {
  return target.mailbox === null
    ? mailboxDirectoryStub(env)
    : mailboxStub(env, target.mailbox);
}

async function stubFetch(
  env: Env,
  target: StubTarget,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return stubFor(env, target).fetch(new Request(`${ROUTE_BASE}${path}`, init));
}

/**
 * Read a JSON response off a stub call. A 4xx maps to {@link InputError}
 * (the caller's input named something absent/invalid); anything else is a
 * store fault. `null` on 404 when `allowMissing` is set, for probing.
 */
async function stubJson<T>(
  env: Env,
  target: StubTarget,
  path: string,
  init?: RequestInit,
  allowMissing = false,
): Promise<T | null> {
  const res = await stubFetch(env, target, path, init);
  if (res.status === 404 && allowMissing) {
    return null;
  }
  if (!res.ok) {
    let detail = `mailbox store returned ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") {
        detail = body.error;
      }
    } catch {
      // Non-JSON error body — keep the status line.
    }
    if (res.status === 404 || res.status === 400) {
      throw new InputError(detail);
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function jsonPatch(body: unknown): RequestInit {
  return { ...jsonPost(body), method: "PATCH" };
}

const DIRECTORY: StubTarget = { mailbox: null };
const perMailbox = (address: string): StubTarget => ({ mailbox: address });

// ---------------------------------------------------------------------------
// Registry + probe helpers
// ---------------------------------------------------------------------------

async function listMailboxes(env: Env): Promise<MailboxRecord[]> {
  const body = await stubJson<{ mailboxes: MailboxRecord[] }>(
    env,
    DIRECTORY,
    "/mailboxes",
  );
  return body?.mailboxes ?? [];
}

async function requireMailbox(env: Env, address: string): Promise<MailboxRecord> {
  const body = await stubJson<{ mailbox: MailboxRecord | null }>(
    env,
    DIRECTORY,
    `/mailboxes/${encodeURIComponent(address)}`,
  );
  if (!body?.mailbox) {
    throw new InputError(`Mailbox is not registered: ${address}`);
  }
  return body.mailbox;
}

/** Run `probe` against every registered stub in parallel; first non-null wins. */
async function probeMailboxes<T>(
  env: Env,
  probe: (mailbox: string) => Promise<T | null>,
): Promise<{ mailbox: string; value: T } | null> {
  const mailboxes = await listMailboxes(env);
  const hits = await Promise.all(
    mailboxes.map(async ({ address }) => {
      const value = await probe(address);
      return value === null ? null : { mailbox: address, value };
    }),
  );
  return hits.find((hit) => hit !== null) ?? null;
}

interface LocatedEmail {
  email: StoredEmail;
  attachments: StoredAttachment[];
}

function findEmail(env: Env, id: string) {
  return probeMailboxes<LocatedEmail>(env, (mailbox) =>
    stubJson<LocatedEmail>(env, perMailbox(mailbox), `/emails/${encodeURIComponent(id)}`, undefined, true),
  );
}

function findThread(env: Env, id: string) {
  return probeMailboxes<{ thread: ThreadView }>(env, (mailbox) =>
    stubJson<{ thread: ThreadView }>(env, perMailbox(mailbox), `/threads/${encodeURIComponent(id)}`, undefined, true),
  );
}

/** Probe each stub's per-id GET — one lookup per mailbox, no paging. */
async function findDraft(
  env: Env,
  id: string,
): Promise<{ mailbox: string; draft: DraftRecord } | null> {
  const hit = await probeMailboxes<DraftRecord>(env, async (mailbox) => {
    const body = await stubJson<{ draft: DraftRecord }>(
      env,
      perMailbox(mailbox),
      `/drafts/${encodeURIComponent(id)}`,
      undefined,
      true,
    );
    return body?.draft ?? null;
  });
  return hit === null ? null : { mailbox: hit.mailbox, draft: hit.value };
}

// ---------------------------------------------------------------------------
// Response presenters
// ---------------------------------------------------------------------------

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** List/search rows: identifiers and headers only — never body text. */
function emailSummary(email: StoredEmail) {
  return {
    id: email.id,
    thread_id: email.thread_id,
    direction: email.direction,
    from_addr: email.from_addr,
    to_addr: email.to_addr,
    subject: email.subject,
    status: email.status,
    created_at: email.created_at,
  };
}

/** Detail view: every stored body wrapped as untrusted content. */
function emailDetail(email: StoredEmail) {
  const meta = { from_addr: email.from_addr, subject: email.subject };
  return {
    ...emailSummary(email),
    body_text: email.body_text === null ? null : wrapUntrusted(email.body_text, meta),
    body_html: email.body_html === null ? null : wrapUntrusted(email.body_html, meta),
  };
}

function attachmentView(attachment: StoredAttachment) {
  return {
    part_id: attachment.part_id,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    size: attachment.size,
    content_id: attachment.content_id,
    r2_key: attachment.r2_key,
  };
}

function mailboxView(mailbox: MailboxRecord) {
  return {
    address: mailbox.address,
    label: mailbox.label,
    agent: mailbox.agent,
    created_at: mailbox.created_at,
  };
}

function replyAddress(email: StoredEmail): string {
  return email.direction === "inbound" ? email.from_addr : email.to_addr;
}

function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

// ---------------------------------------------------------------------------
// Arg parsing — the SDK validates these against the published JSON schema;
// handlers re-parse so direct `registry.invoke` callers get the same gate.
// ---------------------------------------------------------------------------

function parseArgs<S extends z.ZodType>(schema: S, args: Record<string, unknown>): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new InputError(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// registerEmailTools
// ---------------------------------------------------------------------------

export function registerEmailTools(registry: ToolRegistry, env: Env): void {
  const READ: Scope = "email:read";
  const DRAFT: Scope = "email:draft";
  const SEND: Scope = "email:send";
  const DELETE: Scope = "email:delete";

  registry.registerTool(
    "list_mailboxes",
    READ,
    async () => {
      const mailboxes = await listMailboxes(env);
      return jsonResult({ mailboxes: mailboxes.map(mailboxView) });
    },
    {
      description: "List registered mailbox addresses.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
  );

  const listEmailsSchema = z.object({
    mailbox: mailboxField,
    status: emailStatusField.optional(),
    limit: limitField,
  });
  registry.registerTool(
    "list_emails",
    READ,
    async (args) => {
      const { mailbox, status, limit } = parseArgs(listEmailsSchema, args);
      await requireMailbox(env, mailbox);
      const params = new URLSearchParams({ mailbox });
      if (status !== undefined) params.set("status", status);
      if (limit !== undefined) params.set("limit", String(limit));
      const body = await stubJson<{ emails: StoredEmail[] }>(
        env,
        perMailbox(mailbox),
        `/emails?${params.toString()}`,
      );
      return jsonResult({
        mailbox,
        emails: (body?.emails ?? []).map(emailSummary),
      });
    },
    {
      description: "List emails in a mailbox (headers only — no bodies).",
      inputSchema: {
        mailbox: mailboxField,
        status: emailStatusField.optional(),
        limit: limitField,
      },
      annotations: { readOnlyHint: true },
    },
  );

  const getEmailSchema = z.object({ id: idField });
  registry.registerTool(
    "get_email",
    READ,
    async (args) => {
      const { id } = parseArgs(getEmailSchema, args);
      const hit = await findEmail(env, id);
      if (hit === null) {
        throw new InputError(`Email not found: ${id}`);
      }
      return jsonResult({
        mailbox: hit.mailbox,
        email: {
          ...emailDetail(hit.value.email),
          attachments: hit.value.attachments.map(attachmentView),
        },
      });
    },
    {
      description: "Fetch one email by id; bodies arrive untrusted-wrapped.",
      inputSchema: { id: idField },
      annotations: { readOnlyHint: true },
    },
  );

  const getThreadSchema = z.object({ thread_id: idField });
  registry.registerTool(
    "get_thread",
    READ,
    async (args) => {
      const { thread_id } = parseArgs(getThreadSchema, args);
      const hit = await findThread(env, thread_id);
      if (hit === null) {
        throw new InputError(`Thread not found: ${thread_id}`);
      }
      const { thread } = hit.value;
      return jsonResult({
        mailbox: hit.mailbox,
        thread: {
          id: thread.id,
          subject: thread.subject,
          last_message_at: thread.last_message_at,
          // Attachment manifests stay behind get_email — the thread view
          // would need one store call per message to fill them.
          emails: thread.emails.map(emailDetail),
        },
      });
    },
    {
      description: "Fetch a thread with all messages (bodies untrusted-wrapped).",
      inputSchema: { thread_id: idField },
      annotations: { readOnlyHint: true },
    },
  );

  const searchEmailsSchema = z.object({
    query: z.string().min(1),
    mailbox: mailboxField.optional(),
    limit: limitField,
  });
  registry.registerTool(
    "search_emails",
    READ,
    async (args) => {
      const { query, mailbox, limit } = parseArgs(searchEmailsSchema, args);
      const searchOne = async (address: string) => {
        const params = new URLSearchParams({ q: query, mailbox: address });
        if (limit !== undefined) params.set("limit", String(limit));
        const body = await stubJson<{ emails: StoredEmail[] }>(
          env,
          perMailbox(address),
          `/emails/search?${params.toString()}`,
        );
        return (body?.emails ?? []).map(
          (email) => ({ mailbox: address, ...emailSummary(email) }),
        );
      };
      let emails: Array<{ mailbox: string } & ReturnType<typeof emailSummary>>;
      if (mailbox !== undefined) {
        await requireMailbox(env, mailbox);
        emails = await searchOne(mailbox);
      } else {
        // No mailbox: fan out to every registered mailbox and merge
        // newest-first, capped at the requested limit.
        const mailboxes = await listMailboxes(env);
        const merged = (await Promise.all(mailboxes.map(({ address }) => searchOne(address))))
          .flat()
          .sort((a, b) => b.created_at - a.created_at);
        emails = merged.slice(0, limit ?? MAX_LIMIT);
      }
      return jsonResult({ query, mailbox: mailbox ?? null, emails });
    },
    {
      description: "Full-text search; fans out across mailboxes when none is given.",
      inputSchema: {
        query: z.string().min(1),
        mailbox: mailboxField.optional(),
        limit: limitField,
      },
      annotations: { readOnlyHint: true },
    },
  );

  const createDraftSchema = z.object({
    mailbox: mailboxField,
    to: z.string().min(1),
    subject: z.string(),
    body: z.string(),
    thread_id: idField.optional(),
  });
  registry.registerTool(
    "create_draft",
    DRAFT,
    async (args) => {
      const input = parseArgs(createDraftSchema, args);
      await requireMailbox(env, input.mailbox);
      const body = await stubJson<{ draft: DraftRecord }>(
        env,
        perMailbox(input.mailbox),
        "/drafts",
        jsonPost({
          to_addr: input.to,
          subject: input.subject,
          body_text: input.body,
          ...(input.thread_id !== undefined ? { thread_id: input.thread_id } : {}),
        }),
      );
      return jsonResult({ mailbox: input.mailbox, draft: body?.draft ?? null });
    },
    {
      description: "Create a draft email in a mailbox.",
      inputSchema: {
        mailbox: mailboxField,
        to: z.string().min(1),
        subject: z.string(),
        body: z.string(),
        thread_id: idField.optional(),
      },
      annotations: { readOnlyHint: false },
    },
  );

  const updateDraftFields = z
    .object({
      to_addr: z.string().min(1).optional(),
      subject: z.string().optional(),
      body_text: z.string().optional(),
      status: z.enum(DRAFT_UPDATE_STATUSES).optional(),
    })
    .refine((fields) => Object.values(fields).some((value) => value !== undefined), {
      message: "fields must set at least one of to_addr, subject, body_text, status",
    });
  const updateDraftSchema = z.object({
    draft_id: idField,
    fields: updateDraftFields,
  });
  registry.registerTool(
    "update_draft",
    DRAFT,
    async (args) => {
      const { draft_id, fields } = parseArgs(updateDraftSchema, args);
      const located = await findDraft(env, draft_id);
      if (located === null) {
        throw new InputError(`Draft not found: ${draft_id}`);
      }
      const body = await stubJson<{ draft: DraftRecord }>(
        env,
        perMailbox(located.mailbox),
        `/drafts/${encodeURIComponent(draft_id)}`,
        jsonPatch(fields),
      );
      return jsonResult({ mailbox: located.mailbox, draft: body?.draft ?? null });
    },
    {
      description: "Edit an existing draft (to_addr/subject/body_text/status).",
      inputSchema: {
        draft_id: idField,
        fields: z
          .object({
            to_addr: z.string().min(1).optional(),
            subject: z.string().optional(),
            body_text: z.string().optional(),
            status: z.enum(DRAFT_UPDATE_STATUSES).optional(),
          })
          .refine((fields) => Object.values(fields).some((value) => value !== undefined), {
            message: "fields must set at least one of to_addr, subject, body_text, status",
          }),
      },
      annotations: { readOnlyHint: false },
    },
  );

  const draftReplySchema = z.object({
    email_id: idField,
    body: z.string().min(1),
  });
  registry.registerTool(
    "draft_reply",
    DRAFT,
    async (args) => {
      const { email_id, body: text } = parseArgs(draftReplySchema, args);
      const hit = await findEmail(env, email_id);
      if (hit === null) {
        throw new InputError(`Email not found: ${email_id}`);
      }
      const { email } = hit.value;
      const body = await stubJson<{ draft: DraftRecord }>(
        env,
        perMailbox(hit.mailbox),
        "/drafts",
        jsonPost({
          to_addr: replyAddress(email),
          subject: replySubject(email.subject),
          body_text: text,
          thread_id: email.thread_id,
        }),
      );
      return jsonResult({
        mailbox: hit.mailbox,
        in_reply_to: email.id,
        draft: body?.draft ?? null,
      });
    },
    {
      description: "Draft a reply to an email (threads onto the original).",
      inputSchema: { email_id: idField, body: z.string().min(1) },
      annotations: { readOnlyHint: false },
    },
  );

  const sendEmailSchema = z.object({
    draft_id: idField.optional(),
    mailbox: mailboxField.optional(),
    to: z.string().min(1).optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
  });
  registry.registerTool(
    "send_email",
    SEND,
    async (args) => {
      const input = parseArgs(sendEmailSchema, args);
      // Exactly one form: send an existing draft, or send a fresh compose.
      // A mixed payload (draft_id beside compose fields) is ambiguous —
      // refuse it rather than silently discarding the composed content.
      if (input.draft_id !== undefined) {
        if (
          input.mailbox !== undefined ||
          input.to !== undefined ||
          input.subject !== undefined ||
          input.body !== undefined
        ) {
          throw new InputError(
            "send_email takes draft_id OR mailbox+to+subject+body — not both.",
          );
        }
        const located = await findDraft(env, input.draft_id);
        if (located === null) {
          throw new InputError(`Draft not found: ${input.draft_id}`);
        }
        const { draft } = located;
        if (draft.status !== "draft") {
          throw new InputError(
            `Draft ${draft.id} is not editable (status: ${draft.status}).`,
          );
        }
        // Freeze the draft's content into the approval: the approver sees
        // exactly what ships, and the executor never re-reads the mutable
        // drafts row at send time.
        const approval = await queueEmailApproval(env, {
          kind: "email_send",
          mailbox: located.mailbox,
          payload: {
            to_addr: draft.to_addr,
            subject: draft.subject,
            body_text: draft.body_text,
            ...(draft.thread_id !== null ? { thread_id: draft.thread_id } : {}),
            draft_id: draft.id,
          },
        });
        return jsonResult({
          status: "pending_approval",
          kind: "email_send",
          mailbox: located.mailbox,
          approval_id: approval.approval_id,
        });
      }
      if (
        input.mailbox === undefined ||
        input.to === undefined ||
        input.subject === undefined ||
        input.body === undefined
      ) {
        throw new InputError(
          "send_email requires draft_id, or mailbox+to+subject+body.",
        );
      }
      await requireMailbox(env, input.mailbox);
      const approval = await queueEmailApproval(env, {
        kind: "email_send",
        mailbox: input.mailbox,
        payload: {
          to_addr: input.to,
          subject: input.subject,
          body_text: input.body,
        },
      });
      return jsonResult({
        status: "pending_approval",
        kind: "email_send",
        mailbox: input.mailbox,
        approval_id: approval.approval_id,
      });
    },
    {
      description:
        "Queue an email for sending — never sends directly; returns a pending approval.",
      inputSchema: {
        draft_id: idField.optional(),
        mailbox: mailboxField.optional(),
        to: z.string().min(1).optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  );

  const sendReplySchema = z.object({
    email_id: idField,
    body: z.string().min(1),
  });
  registry.registerTool(
    "send_reply",
    SEND,
    async (args) => {
      const { email_id, body: text } = parseArgs(sendReplySchema, args);
      const hit = await findEmail(env, email_id);
      if (hit === null) {
        throw new InputError(`Email not found: ${email_id}`);
      }
      const { email } = hit.value;
      const approval = await queueEmailApproval(env, {
        kind: "email_send",
        mailbox: hit.mailbox,
        payload: {
          to_addr: replyAddress(email),
          subject: replySubject(email.subject),
          body_text: text,
          thread_id: email.thread_id,
          in_reply_to_email_id: email.id,
        },
      });
      return jsonResult({
        status: "pending_approval",
        kind: "email_send",
        mailbox: hit.mailbox,
        in_reply_to: email.id,
        approval_id: approval.approval_id,
      });
    },
    {
      description:
        "Queue a reply for sending — never sends directly; returns a pending approval.",
      inputSchema: { email_id: idField, body: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  );

  const markReadSchema = z.object({ id: idField });
  registry.registerTool(
    "mark_email_read",
    READ,
    async (args) => {
      const { id } = parseArgs(markReadSchema, args);
      const hit = await probeMailboxes<{ email: StoredEmail; changed: boolean }>(
        env,
        (mailbox) =>
          stubJson<{ email: StoredEmail; changed: boolean }>(
            env,
            perMailbox(mailbox),
            `/emails/${encodeURIComponent(id)}/read`,
            jsonPost({}),
            true,
          ),
      );
      if (hit === null) {
        throw new InputError(`Email not found: ${id}`);
      }
      return jsonResult({
        mailbox: hit.mailbox,
        email: emailSummary(hit.value.email),
        changed: hit.value.changed,
      });
    },
    {
      description: "Mark an email read (idempotent).",
      inputSchema: { id: idField },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
  );

  const moveEmailSchema = z.object({ id: idField, status: emailStatusField });
  registry.registerTool(
    "move_email",
    DRAFT,
    async (args) => {
      const { id, status } = parseArgs(moveEmailSchema, args);
      const hit = await probeMailboxes<{ email: StoredEmail }>(env, (mailbox) =>
        stubJson<{ email: StoredEmail }>(
          env,
          perMailbox(mailbox),
          `/emails/${encodeURIComponent(id)}/move`,
          jsonPost({ status }),
          true,
        ),
      );
      if (hit === null) {
        throw new InputError(`Email not found: ${id}`);
      }
      return jsonResult({
        mailbox: hit.mailbox,
        email: emailSummary(hit.value.email),
      });
    },
    {
      description: "Move an email between statuses (unread/read/archived/sent/deleted).",
      inputSchema: { id: idField, status: emailStatusField },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
  );

  const deleteEmailSchema = z.object({ id: idField });
  registry.registerTool(
    "delete_email",
    DELETE,
    async (args) => {
      const { id } = parseArgs(deleteEmailSchema, args);
      const hit = await findEmail(env, id);
      if (hit === null) {
        throw new InputError(`Email not found: ${id}`);
      }
      const { email } = hit.value;
      const approval = await queueEmailApproval(env, {
        kind: "email_delete",
        mailbox: hit.mailbox,
        payload: {
          email_id: email.id,
          subject: email.subject,
          from_addr: email.from_addr,
        },
      });
      return jsonResult({
        status: "pending_approval",
        kind: "email_delete",
        mailbox: hit.mailbox,
        email_id: email.id,
        approval_id: approval.approval_id,
      });
    },
    {
      description:
        "Queue an email for deletion — never deletes directly; returns a pending approval.",
      inputSchema: { id: idField },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  );
}
