/**
 * Inbound email handler (megaplan task 3): the worker's `email()` export
 * calls {@link handleInboundEmail} once per delivery.
 *
 * Pipeline: envelope recipient → registered-mailbox check via the Mailbox
 * directory stub → `message.raw.tee()` (one branch streams into
 * `postal-mime`, the other stays queued for the raw-source dump; the tee
 * is what keeps the source readable for a dump on parse failure — it does
 * NOT save memory: tee() enqueues every chunk into both branch queues, so
 * while the parser runs the dump branch is buffering a full second copy
 * anyway) → attachment bodies to the `ATTACHMENTS` R2 bucket keyed
 * `emailId/partId` → store the email through the per-address Mailbox DO
 * with a manifest row per landed part (bodies first, so a committed
 * `r2_key` always resolves to a real object).
 *
 * Registered-only rule (megaplan constraint): a recipient with no registry
 * row is rejected with `message.setReject("Unknown address")` and counted —
 * no store call is made. A directory lookup that *fails* (rather than
 * answering "not registered") is not a verdict on the address: throwing
 * fails the delivery transiently so Email Routing redelivers (the same
 * at-least-once retry the `message_id` dedup absorbs) instead of bouncing
 * a possibly-registered sender as "Unknown address". A failed store write
 * is the opposite case: the recipient is confirmed registered but the
 * record is lost unless rejected, so `setReject` runs there.
 *
 * Parse failure: never thrown, never rejected. The raw Subject header is
 * stored verbatim and the record is flagged with {@link PARSE_FAILED_FLAG}
 * in `body_text`; the untouched RFC822 source lands in R2 as
 * `emailId/raw-source` (recorded in the attachment manifest) so nothing is
 * lost to a parser bug or hostile MIME.
 */
import PostalMime, { type Address, type Attachment } from "postal-mime";
import type { Env } from "./env.js";
import { mailboxDirectoryStub, mailboxStub } from "./mailbox-do.js";
import {
  randomHex,
  type AddEmailInput,
  type EmailAttachmentInput,
} from "./mailbox-store.js";
import { redactSecrets } from "./security.js";

const ROUTE_BASE = "https://internal/internal/mailbox";

/** Marker at the head of `body_text` on records stored from unparseable mail. */
export const PARSE_FAILED_FLAG = "[parse_failed]";

const EMPTY_SUBJECT = "(no subject)";

/** Same shape the store enforces — checked locally so a fallback is chosen
 * before a bad sender value ever reaches the DO. */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const stats = {
  received: 0,
  stored: 0,
  parseFailed: 0,
  unregisteredDrops: 0,
  // Redeliveries folded into the first stored copy by `message_id` dedup —
  // counted so at-least-once replay volume is visible, not just logged.
  duplicates: 0,
  // Directory lookups that fail are gate failures, not correct rejections —
  // folding them into `unregisteredDrops` would hide real drops' signal.
  directoryErrors: 0,
};

/** Per-isolate counters for observability; durable accounting is via logs. */
export function inboundEmailStats(): Readonly<typeof stats> {
  return { ...stats };
}

/** Test/debug helper — counters are process state, not records. */
export function resetInboundEmailStats(): void {
  stats.received = 0;
  stats.stored = 0;
  stats.parseFailed = 0;
  stats.unregisteredDrops = 0;
  stats.duplicates = 0;
  stats.directoryErrors = 0;
}

function logWarn(event: string, detail: Record<string, unknown>): void {
  console.warn(redactSecrets(`${event} ${JSON.stringify(detail)}`));
}

/**
 * Normalize an envelope/header recipient to the registry's `x@y.z` form:
 * strips `Name <a@b>` display syntax, lowercases, trims.
 */
function envelopeAddress(raw: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  return (angle?.[1] ?? raw).trim().toLowerCase();
}

/** First syntactically valid address among the candidates, else undefined. */
function firstValidAddress(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && ADDRESS_RE.test(candidate.trim())) {
      return candidate.trim();
    }
  }
  return undefined;
}

/** postal-mime `Address`: a single mailbox or a group. */
function firstMailboxAddress(address: Address | undefined): string | undefined {
  if (!address) {
    return undefined;
  }
  if (address.address !== undefined) {
    return address.address;
  }
  return address.group?.[0]?.address;
}

/** `References`/`In-Reply-To` carry `<id>` tokens; pass them through as a list. */
function splitMessageIds(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const bracketed = raw.match(/<[^<>\s]+>/g);
  if (bracketed && bracketed.length > 0) {
    return bracketed;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : [trimmed];
}

async function isRegistered(env: Env, address: string): Promise<boolean | "error"> {
  const res = await mailboxDirectoryStub(env).fetch(
    new Request(`${ROUTE_BASE}/mailboxes/${encodeURIComponent(address)}`),
  );
  if (!res.ok) {
    logWarn("inbound_email_directory_lookup_failed", { to: address, status: res.status });
    return "error";
  }
  const body = (await res.json()) as { registered?: boolean };
  return body.registered === true;
}

/** POST one email record into the mailbox's DO; returns the stored id. */
async function storeEmail(env: Env, to: string, input: AddEmailInput): Promise<string | null> {
  try {
    const res = await mailboxStub(env, to).fetch(
      new Request(`${ROUTE_BASE}/emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    if (!res.ok) {
      logWarn("inbound_email_store_failed", { to, status: res.status });
      return null;
    }
    const body = (await res.json()) as { email?: { id?: string } };
    return body.email?.id ?? null;
  } catch (error) {
    // A thrown fetch (unreachable DO, dead stub) is the same store failure
    // as a non-ok response: `null` routes it through reconcileStoreResult,
    // which cleans up bodies already written and rejects the delivery.
    logWarn("inbound_email_store_failed", {
      to,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** RFC3339/Date header → epoch ms; unparseable/absent → undefined (store defaults now). */
function messageDateMs(date: string | undefined): number | undefined {
  if (!date) {
    return undefined;
  }
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Decode a parsed part body to bytes once — the R2 write and manifest size share it. */
function contentBytes(content: Attachment["content"]): Uint8Array {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

async function putAttachment(
  env: Env,
  key: string,
  content: Uint8Array,
  meta: { filename: string; mimeType: string; contentId: string },
): Promise<void> {
  // customMetadata values are serialized into HTTP headers — keep
  // `filename` out of them: a non-Latin-1 name (common in real mail) would
  // fail the whole put, and the manifest row already preserves the true
  // name. mimeType/contentId are ASCII by RFC.
  const customMetadata = Object.fromEntries(
    Object.entries({ mimeType: meta.mimeType, contentId: meta.contentId }).filter(
      ([, v]) => v !== "",
    ),
  );
  await env.ATTACHMENTS.put(key, content, {
    httpMetadata: meta.mimeType === "" ? undefined : { contentType: meta.mimeType },
    customMetadata: Object.keys(customMetadata).length === 0 ? undefined : customMetadata,
  });
}

/** One parsed attachment plus its minted part id and decoded body. */
interface PreparedAttachment {
  partId: string;
  bytes: Uint8Array;
  meta: { filename: string; mimeType: string; contentId: string };
}

function prepareAttachments(attachments: Attachment[]): PreparedAttachment[] {
  return attachments.map((attachment, i) => {
    const partId = `part-${i}`;
    return {
      partId,
      bytes: contentBytes(attachment.content),
      meta: {
        filename: attachment.filename ?? "",
        mimeType: attachment.mimeType,
        contentId: attachment.contentId ?? "",
      },
    };
  });
}

function attachmentManifest(emailId: string, prepared: PreparedAttachment[]): EmailAttachmentInput[] {
  return prepared.map(({ partId, bytes, meta }) => ({
    part_id: partId,
    filename: meta.filename || undefined,
    mime_type: meta.mimeType || undefined,
    size: bytes.byteLength,
    content_id: meta.contentId || undefined,
    r2_key: `${emailId}/${partId}`,
  }));
}

/**
 * Every attachment body lands under `emailId/partId` and runs BEFORE the
 * record write commits the manifest — so a committed `r2_key` always
 * resolves to a real object. A part whose put fails is logged and dropped
 * from the returned list (it gets no manifest row); the caller's email
 * insert can only orphan objects on failure, never dangle a row.
 */
async function storeAttachments(
  env: Env,
  emailId: string,
  prepared: PreparedAttachment[],
): Promise<PreparedAttachment[]> {
  const writes = prepared.map(async (part) => {
    try {
      await putAttachment(env, `${emailId}/${part.partId}`, part.bytes, part.meta);
      return part;
    } catch (error) {
      logWarn("inbound_email_attachment_write_failed", {
        emailId,
        part: part.partId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });
  return (await Promise.all(writes)).filter(
    (part): part is PreparedAttachment => part !== null,
  );
}

/** Best-effort delete of bodies whose manifest rows were never committed. */
async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      try {
        await env.ATTACHMENTS.delete(key);
      } catch (error) {
        logWarn("inbound_email_attachment_delete_failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}

/**
 * Reconcile the store POST's result after bodies were already written.
 * `null` (the write failed) → clean up the orphaned objects and reject so
 * the MTA reports the drop. An id different from the one we minted means
 * the store folded this delivery into an earlier copy (the `message_id`
 * dedup in addEmail — Email Routing is at-least-once): the fresh bodies
 * are unreferenced duplicates, so delete them and count nothing stored.
 */
async function reconcileStoreResult(
  env: Env,
  message: ForwardableEmailMessage,
  emailId: string | null,
  mintedId: string,
  orphanKeys: string[],
): Promise<"stored" | "rejected" | "duplicate"> {
  if (emailId === null) {
    await deleteObjects(env, orphanKeys);
    // A registered recipient whose store write fails would be acked and
    // permanently lost; the bounce reports the drop to the sender's MTA.
    message.setReject("Mailbox storage failed");
    return "rejected";
  }
  if (emailId !== mintedId) {
    await deleteObjects(env, orphanKeys);
    logWarn("inbound_email_duplicate_delivery", { emailId });
    return "duplicate";
  }
  return "stored";
}

/**
 * Inbound delivery entrypoint. Awaiting everything inline keeps the result
 * observable without a runtime context; when `ctx` is present the same work
 * is registered with `waitUntil` so an early isolate return cannot cut the
 * R2 writes short.
 */
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  stats.received += 1;
  const to = envelopeAddress(message.to ?? "");

  let registered: boolean | "error";
  try {
    registered = await isRegistered(env, to);
  } catch (error) {
    logWarn("inbound_email_directory_lookup_failed", {
      to,
      error: error instanceof Error ? error.message : String(error),
    });
    registered = "error";
  }
  if (registered !== true) {
    if (registered === "error") {
      stats.directoryErrors += 1;
      // The lookup failure says nothing about the address — it may be
      // registered. Throwing fails this delivery transiently so Email
      // Routing redelivers instead of bouncing the sender as "Unknown
      // address"; a redelivery that lands after recovery hits the
      // `message_id` dedup like any other at-least-once replay.
      throw new Error(`Mailbox directory lookup failed for ${to}.`);
    }
    stats.unregisteredDrops += 1;
    logWarn("inbound_email_dropped_unregistered", { to, reason: registered });
    message.setReject("Unknown address");
    return;
  }

  // Tee the raw stream: one branch feeds the parser, the other stays
  // queued for the raw-source dump and is canceled once parsing succeeds.
  // tee() enqueues every chunk into BOTH branch queues, so during the
  // parse the dump branch is already buffering a second copy of the whole
  // message — the same peak as pre-buffering; what the tee buys is a
  // re-readable source for the failure path, not a smaller footprint.
  const [parseRaw, dumpRaw] = message.raw.tee();
  let parsed = null;
  try {
    parsed = await PostalMime.parse(parseRaw);
  } catch (error) {
    // The parse failure path below still stores the mail — this log is the
    // only trace of *why* the parser rejected it, so the error is kept.
    logWarn("inbound_email_parse_failed", {
      to,
      error: error instanceof Error ? error.message : String(error),
    });
    parsed = null;
  }

  if (parsed !== null) {
    await dumpRaw.cancel().catch(() => undefined);
    // The email id is minted here (not by the store) so attachment R2 keys
    // and manifest rows are built from one value: bodies are written to R2
    // first (a committed manifest row always resolves), then one DO call
    // stores the row and its manifest together.
    const id = `eml-${randomHex(8)}`;
    const prepared = prepareAttachments(parsed.attachments);
    const writes = storeAttachments(env, id, prepared);
    ctx?.waitUntil?.(writes);
    const landed = await writes;
    const from =
      firstValidAddress(firstMailboxAddress(parsed.from), envelopeAddress(message.from ?? "")) ??
      "unknown@unknown.invalid";
    const input: AddEmailInput = {
      id,
      direction: "inbound",
      from_addr: from,
      to_addr: to,
      subject: parsed.subject?.trim() || EMPTY_SUBJECT,
      body_text: parsed.text ?? null,
      body_html: parsed.html ?? null,
      message_id: parsed.messageId,
      in_reply_to: parsed.inReplyTo,
      references: splitMessageIds(parsed.references),
      created_at: messageDateMs(parsed.date),
      attachments: attachmentManifest(id, landed),
    };
    const emailId = await storeEmail(env, to, input);
    const outcome = await reconcileStoreResult(
      env,
      message,
      emailId,
      id,
      landed.map((part) => `${id}/${part.partId}`),
    );
    if (outcome === "stored") {
      stats.stored += 1;
    } else if (outcome === "duplicate") {
      stats.duplicates += 1;
    }
    return;
  }

  // Parse failure: keep the raw Subject verbatim, flag the record, and dump
  // the untouched source to R2 — the mail is stored, never crashed on. The
  // dead parse branch is canceled first so its queued copy of the message
  // is freed while the dump branch drains.
  stats.parseFailed += 1;
  await parseRaw.cancel().catch(() => undefined);
  let raw: ArrayBuffer | null = null;
  try {
    raw = await new Response(dumpRaw).arrayBuffer();
  } catch (error) {
    logWarn("inbound_email_raw_read_failed", {
      to,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const id = `eml-${randomHex(8)}`;
  // Same rule as the parsed path: the manifest row is committed only when
  // its object exists, so the dump lands before the store write. A failed
  // put just means no row — the parse_failed flag still records the loss.
  let rawStored = false;
  if (raw !== null) {
    try {
      const write = env.ATTACHMENTS.put(`${id}/raw-source`, raw, {
        httpMetadata: { contentType: "message/rfc822" },
      });
      ctx?.waitUntil?.(write);
      await write;
      rawStored = true;
    } catch (error) {
      logWarn("inbound_email_raw_source_write_failed", {
        emailId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const rawSubject = message.headers?.get("subject")?.trim() || EMPTY_SUBJECT;
  const from = firstValidAddress(
    envelopeAddress(message.headers?.get("from") ?? ""),
    envelopeAddress(message.from ?? ""),
  ) ?? "unknown@unknown.invalid";
  const attachments: EmailAttachmentInput[] | undefined =
    raw !== null && rawStored
      ? [
          {
            part_id: "raw-source",
            filename: "raw-source.eml",
            mime_type: "message/rfc822",
            size: raw.byteLength,
            r2_key: `${id}/raw-source`,
          },
        ]
      : undefined;
  const emailId = await storeEmail(env, to, {
    id,
    direction: "inbound",
    from_addr: from,
    to_addr: to,
    subject: rawSubject,
    body_text: rawStored
      ? `${PARSE_FAILED_FLAG} postal-mime could not parse this message; raw source preserved in the attachments bucket as raw-source.`
      : `${PARSE_FAILED_FLAG} postal-mime could not parse this message; raw source could not be recovered to the attachments bucket.`,
    message_id: message.headers?.get("message-id") ?? undefined,
    in_reply_to: message.headers?.get("in-reply-to") ?? undefined,
    references: splitMessageIds(message.headers?.get("references") ?? undefined),
    attachments,
  });
  const outcome = await reconcileStoreResult(
    env,
    message,
    emailId,
    id,
    rawStored ? [`${id}/raw-source`] : [],
  );
  if (outcome === "stored") {
    stats.stored += 1;
  } else if (outcome === "duplicate") {
    stats.duplicates += 1;
  }
}
