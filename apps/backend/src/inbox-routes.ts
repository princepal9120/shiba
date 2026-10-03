/**
 * `/api/mailboxes|emails|threads|drafts` — the dashboard inbox. Read routes
 * proxy the Mailbox DO namespace; bare ids resolve by probing registered
 * mailboxes (the same strategy mcp-email-tools.ts uses). Extracted from
 * index.ts; the Access gate stays on this surface.
 */
import { emailApprovalBridgeReady, queueEmailApproval } from "./email-approvals.js";
import type { Env } from "./env.js";
import { mailboxDirectoryStub, mailboxStub } from "./mailbox-do.js";
import type {
  DraftRecord,
  MailboxRecord,
  StoredAttachment,
  StoredEmail,
  ThreadView,
} from "./mailbox-store.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { clampedLimit, jsonObjectBody, methodNotAllowed } from "./route-utils.js";
import { InputError, NotFoundError } from "./security.js";

// ---------- Dashboard inbox + memory API (megaplan T11) ----------
//
// Read routes proxy the Mailbox DO namespace (T2 contract): the `__directory__`
// stub lists registered mailboxes, each address stub serves JSON under
// `/internal/mailbox/*`. Bare ids (email, thread, draft) resolve by probing
// the registered mailboxes — the same strategy mcp-email-tools.ts uses.
// Memory routes target the shared "global" Memory DO stub (T8 contract: a
// JSON fetch API mirroring mailbox) and answer 503 until that binding ships.

const MAILBOX_DO_BASE = "https://internal/internal/mailbox";
const INBOX_LIST_LIMIT = 50;

async function mailboxDoJson<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await stub.fetch(`${MAILBOX_DO_BASE}${path}`, init);
  if (!response.ok) {
    const text = (await response.text()).trim();
    const message =
      text === "" ? `Mailbox request failed (HTTP ${response.status})` : text;
    if (response.status === 404) {
      throw new NotFoundError(message);
    }
    if (response.status === 400) {
      throw new InputError(message);
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}


async function mailboxDoJsonOrNull<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    return await mailboxDoJson<T>(stub, path, init);
  } catch (error) {
    if (error instanceof InputError) {
      return null;
    }
    throw error;
  }
}

async function registeredMailboxes(env: Env): Promise<MailboxRecord[]> {
  const body = await mailboxDoJson<{ mailboxes?: MailboxRecord[] }>(
    mailboxDirectoryStub(env),
    "/mailboxes",
  );
  return body.mailboxes ?? [];
}

/**
 * Resolve a user-supplied mailbox address to a registered one, or null.
 * Callers must check before `mailboxStub`: `idFromName` instantiates a DO
 * for any string, so probing an unregistered address would create empty
 * mailboxes at unbounded cardinality.
 */
async function resolveRegisteredMailbox(env: Env, address: string): Promise<string | null> {
  const normalized = address.trim().toLowerCase();
  const record = (await registeredMailboxes(env)).find(
    (entry) => entry.address === normalized,
  );
  return record?.address ?? null;
}

/** First non-null probe result across registered mailboxes, like findDraft's. */
async function probeMailboxes<T>(
  env: Env,
  probe: (stub: DurableObjectStub) => Promise<T | null>,
): Promise<{ mailbox: string; value: T } | null> {
  for (const record of await registeredMailboxes(env)) {
    const value = await probe(mailboxStub(env, record.address));
    if (value !== null) {
      return { mailbox: record.address, value };
    }
  }
  return null;
}

/** Merge rows from every registered mailbox, tagging each with its address. */
async function collectMailboxRows<T extends object>(
  env: Env,
  collect: (stub: DurableObjectStub) => Promise<T[]>,
): Promise<Array<T & { mailbox: string }>> {
  const rows: Array<T & { mailbox: string }> = [];
  for (const record of await registeredMailboxes(env)) {
    for (const row of await collect(mailboxStub(env, record.address))) {
      rows.push({ ...row, mailbox: record.address });
    }
  }
  return rows;
}

/** Cross-mailbox draft lookup — a draft id alone does not name its mailbox. */
async function findInboxDraft(
  env: Env,
  draftId: string,
): Promise<{ mailbox: string; draft: DraftRecord } | null> {
  const located = await probeMailboxes(env, async (stub) =>
    mailboxDoJsonOrNull<{ draft: DraftRecord }>(
      stub,
      `/drafts/${encodeURIComponent(draftId)}`,
    ),
  );
  return located === null ? null : { mailbox: located.mailbox, draft: located.value.draft };
}

/**
 * POST /api/drafts/:id/send — the dashboard's entry into the same approval
 * gate `send_email` uses: lock the draft row, then mint an email_send
 * approval freezing the row the queue CAS returned. Nothing here transmits
 * mail. Lock-then-mint keeps `queued` honest both ways: a failed CAS mints
 * no approval, and the payload is exactly what the row froze — a PATCH
 * racing in ahead of the CAS lands inside the lock, not beside it.
 */
async function queueDraftSend(env: Env, draftId: string): Promise<Response> {
  const located = await findInboxDraft(env, draftId);
  if (located === null) {
    return Response.json(
      { error: `Draft "${draftId}" was not found in any registered mailbox.` },
      { status: 404 },
    );
  }
  const { mailbox, draft } = located;
  if (draft.status !== "draft") {
    return Response.json(
      { error: `Draft "${draftId}" is "${draft.status}" — only drafts in "draft" can be queued for approval.` },
      { status: 409 },
    );
  }
  if (!emailApprovalBridgeReady(env)) {
    return Response.json(
      { error: "Email sending is not configured — the SEND_EMAIL binding is unset, so this draft stays editable." },
      { status: 503 },
    );
  }
  const { draft: queued } = await mailboxDoJson<{ draft: DraftRecord }>(
    mailboxStub(env, mailbox),
    `/drafts/${encodeURIComponent(draftId)}/queue`,
    { method: "POST" },
  );
  let approval: { approval_id: string };
  try {
    approval = await queueEmailApproval(env, {
      kind: "email_send",
      mailbox,
      payload: {
        to_addr: queued.to_addr,
        subject: queued.subject,
        body_text: queued.body_text,
        ...(queued.thread_id !== null ? { thread_id: queued.thread_id } : {}),
        ...(queued.in_reply_to_email_id !== null
          ? { in_reply_to_email_id: queued.in_reply_to_email_id }
          : {}),
        draft_id: queued.id,
      },
    });
  } catch (error) {
    // The queue CAS already landed — without this compensating unqueue the
    // draft strands in `queued` behind an approval that does not exist.
    await mailboxDoJson(mailboxStub(env, mailbox), `/drafts/${encodeURIComponent(draftId)}/unqueue`, {
      method: "POST",
    }).catch((unqueueError) => {
      console.warn(
        `draft unqueue failed after approval mint error ${JSON.stringify({
          draft_id: draftId,
          error: unqueueError instanceof Error ? unqueueError.message : String(unqueueError),
        })}`,
      );
    });
    throw error;
  }
  return Response.json({
    status: "pending_approval",
    kind: "email_send",
    mailbox,
    approval_id: approval.approval_id,
    draft: queued,
  });
}

export async function handleInbox(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const emailId = /^\/api\/emails\/([^/]+)$/.exec(pathname)?.[1];
  const attachmentMatch = /^\/api\/emails\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
  const emailReadId = /^\/api\/emails\/([^/]+)\/read$/.exec(pathname)?.[1];
  const threadId = /^\/api\/threads\/([^/]+)$/.exec(pathname)?.[1];
  const draftSendId = /^\/api\/drafts\/([^/]+)\/send$/.exec(pathname)?.[1];
  if (
    pathname !== "/api/mailboxes" &&
    pathname !== "/api/emails" &&
    pathname !== "/api/emails-search" &&
    pathname !== "/api/drafts" &&
    emailId === undefined &&
    attachmentMatch === null &&
    emailReadId === undefined &&
    threadId === undefined &&
    draftSendId === undefined
  ) {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (env.Mailbox === undefined) {
    return Response.json({ error: "Mailboxes are not provisioned yet." }, { status: 503 });
  }
  try {
    if (pathname === "/api/mailboxes") {
      if (request.method === "POST") {
        // Without a registered address, inbound mail bounces and sends 400.
        const body = await mailboxDoJson<{ mailbox: MailboxRecord }>(
          mailboxDirectoryStub(env),
          "/mailboxes",
          { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() },
        );
        return Response.json(body, { status: 201 });
      }
      if (request.method !== "GET") return methodNotAllowed();
      return Response.json({ mailboxes: await registeredMailboxes(env) });
    }
    if (pathname === "/api/emails" || pathname === "/api/emails-search") {
      if (request.method !== "GET") return methodNotAllowed();
      const limit = clampedLimit(url.searchParams.get("limit"), INBOX_LIST_LIMIT);
      const query = new URLSearchParams();
      const status = url.searchParams.get("status");
      if (status !== null && status !== "") {
        query.set("status", status);
      }
      query.set("limit", String(limit));
      let path = "/emails";
      if (pathname === "/api/emails-search") {
        const q = url.searchParams.get("q")?.trim() ?? "";
        if (q === "") {
          return Response.json({ error: "Provide a q query parameter." }, { status: 400 });
        }
        query.set("q", q);
        path = "/emails/search";
      }
      const mailbox = url.searchParams.get("mailbox");
      if (mailbox !== null && mailbox !== "") {
        const registered = await resolveRegisteredMailbox(env, mailbox);
        if (registered === null) {
          return Response.json(
            { error: `"${mailbox}" is not a registered mailbox.` },
            { status: 400 },
          );
        }
        const body = await mailboxDoJson<{ emails?: StoredEmail[] }>(
          mailboxStub(env, registered),
          `${path}?${query.toString()}`,
        );
        return Response.json({ mailbox: registered, emails: body.emails ?? [] });
      }
      const emails = await collectMailboxRows<StoredEmail>(env, async (stub) => {
        const body = await mailboxDoJson<{ emails?: StoredEmail[] }>(
          stub,
          `${path}?${query.toString()}`,
        );
        return body.emails ?? [];
      });
      emails.sort((a, b) => b.created_at - a.created_at);
      return Response.json({ emails: emails.slice(0, limit) });
    }
    if (emailId !== undefined) {
      if (request.method !== "GET") return methodNotAllowed();
      const located = await probeMailboxes(env, (stub) =>
        mailboxDoJsonOrNull<{ email: StoredEmail; attachments?: StoredAttachment[] }>(
          stub,
          `/emails/${encodeURIComponent(emailId)}`,
        ),
      );
      if (located === null) {
        return Response.json(
          { error: `Email "${emailId}" was not found in any registered mailbox.` },
          { status: 404 },
        );
      }
      return Response.json({
        mailbox: located.mailbox,
        email: located.value.email,
        // Attachment rows carry internal storage fields (r2_key, content_id);
        // the wire shape is the dashboard's InboxAttachment only.
        attachments: (located.value.attachments ?? []).map((attachment) => ({
          part_id: attachment.part_id,
          filename: attachment.filename,
          mime_type: attachment.mime_type,
          size: attachment.size,
        })),
      });
    }
    if (attachmentMatch !== null) {
      if (request.method !== "GET") return methodNotAllowed();
      const [, attachmentEmailId, partId] = attachmentMatch;
      const located = await probeMailboxes(env, (stub) =>
        mailboxDoJsonOrNull<{ attachments?: StoredAttachment[] }>(
          stub,
          `/emails/${encodeURIComponent(attachmentEmailId!)}`,
        ),
      );
      const attachment = located?.value.attachments?.find((part) => part.part_id === partId);
      if (!attachment) {
        return Response.json({ error: "Attachment not found." }, { status: 404 });
      }
      // The manifest, not the URL, chooses the R2 key. Never render untrusted
      // attachment content inline, including HTML/SVG from an email sender.
      const object = await env.ATTACHMENTS.get(attachment.r2_key);
      if (!object) {
        return Response.json({ error: "Attachment body is missing." }, { status: 404 });
      }
      const filename = attachment.filename || "attachment";
      const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodedFilename}`,
          "Content-Length": String(object.size),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (emailReadId !== undefined) {
      if (request.method !== "POST") return methodNotAllowed();
      // The DO's /read route itself 404s on a missing email — one probe each.
      const located = await probeMailboxes(env, (stub) =>
        mailboxDoJsonOrNull<{ email: StoredEmail; changed: boolean }>(
          stub,
          `/emails/${encodeURIComponent(emailReadId)}/read`,
          { method: "POST" },
        ),
      );
      if (located === null) {
        return Response.json(
          { error: `Email "${emailReadId}" was not found in any registered mailbox.` },
          { status: 404 },
        );
      }
      return Response.json({ mailbox: located.mailbox, ...located.value });
    }
    if (threadId !== undefined) {
      if (request.method !== "GET") return methodNotAllowed();
      const located = await probeMailboxes(env, (stub) =>
        mailboxDoJsonOrNull<{ thread: ThreadView }>(
          stub,
          `/threads/${encodeURIComponent(threadId)}`,
        ),
      );
      if (located === null) {
        return Response.json(
          { error: `Thread "${threadId}" was not found in any registered mailbox.` },
          { status: 404 },
        );
      }
      return Response.json({ mailbox: located.mailbox, thread: located.value.thread });
    }
    if (pathname === "/api/drafts") {
      if (request.method === "GET") {
        const limit = clampedLimit(url.searchParams.get("limit"), INBOX_LIST_LIMIT);
        const query = new URLSearchParams();
        const status = url.searchParams.get("status");
        if (status !== null && status !== "") {
          query.set("status", status);
        }
        query.set("limit", String(limit));
        const mailbox = url.searchParams.get("mailbox");
        if (mailbox !== null && mailbox !== "") {
          const registered = await resolveRegisteredMailbox(env, mailbox);
          if (registered === null) {
            return Response.json(
              { error: `"${mailbox}" is not a registered mailbox.` },
              { status: 400 },
            );
          }
          const body = await mailboxDoJson<{ drafts?: DraftRecord[] }>(
            mailboxStub(env, registered),
            `/drafts?${query.toString()}`,
          );
          return Response.json({ mailbox: registered, drafts: body.drafts ?? [] });
        }
        const drafts = await collectMailboxRows<DraftRecord>(env, async (stub) => {
          const body = await mailboxDoJson<{ drafts?: DraftRecord[] }>(
            stub,
            `/drafts?${query.toString()}`,
          );
          return body.drafts ?? [];
        });
        drafts.sort((a, b) => b.updated_at - a.updated_at);
        return Response.json({ drafts: drafts.slice(0, limit) });
      }
      if (request.method === "POST") {
        const body = await jsonObjectBody(request);
        const mailbox = typeof body.mailbox === "string" ? body.mailbox.trim() : "";
        if (mailbox === "") {
          return Response.json({ error: "Provide a mailbox address." }, { status: 400 });
        }
        const registered = await resolveRegisteredMailbox(env, mailbox);
        if (registered === null) {
          return Response.json(
            { error: `"${mailbox}" is not a registered mailbox.` },
            { status: 400 },
          );
        }
        const created = await mailboxDoJson<{ draft: DraftRecord }>(
          mailboxStub(env, registered),
          "/drafts",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to_addr: body.to_addr,
              subject: body.subject,
              body_text: body.body_text,
              ...(typeof body.thread_id === "string" ? { thread_id: body.thread_id } : {}),
              ...(typeof body.in_reply_to_email_id === "string"
                ? { in_reply_to_email_id: body.in_reply_to_email_id }
                : {}),
            }),
          },
        );
        return Response.json({ mailbox: registered, draft: created.draft }, { status: 201 });
      }
      return methodNotAllowed();
    }
    if (draftSendId !== undefined) {
      if (request.method !== "POST") return methodNotAllowed();
      return await queueDraftSend(env, draftSendId);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
