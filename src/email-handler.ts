/**
 * Inbound email handler (megaplan task 3): the worker's `email()` export
 * calls {@link handleInboundEmail} once per delivery.
 *
 * Pipeline: envelope recipient → registered-mailbox check via the Mailbox
 * directory stub → buffer the raw message → `postal-mime` parse → store the
 * email through the per-address Mailbox DO (threading headers are passed
 * through; the store resolves In-Reply-To/References/subject itself) →
 * attachment bodies to the `ATTACHMENTS` R2 bucket keyed `emailId/partId`.
 *
 * Registered-only rule (megaplan constraint): a recipient with no registry
 * row is rejected with `message.setReject("Unknown address")` and counted —
 * no store call is made. A directory lookup that *fails* (rather than
 * answering "not registered") is also rejected: storing unchecked mail
 * would silently bypass the gate, while a bounce at least reports the drop
 * to the sender's MTA.
 *
 * Parse failure: never thrown, never rejected. The raw Subject header is
 * stored verbatim and the record is flagged with {@link PARSE_FAILED_FLAG}
 * in `body_text`; the untouched RFC822 source lands in R2 as
 * `emailId/raw-source` so nothing is lost to a parser bug or hostile MIME.
 */
import PostalMime, { type Address, type Attachment } from "postal-mime";
import type { Env } from "./env.js";
import { mailboxDirectoryStub, mailboxStub } from "./mailbox-do.js";
import type { AddEmailInput } from "./mailbox-store.js";
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
}

/** RFC3339/Date header → epoch ms; unparseable/absent → undefined (store defaults now). */
function messageDateMs(date: string | undefined): number | undefined {
  if (!date) {
    return undefined;
  }
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : undefined;
}

async function putAttachment(
  env: Env,
  key: string,
  content: Attachment["content"],
  meta: Record<string, string>,
): Promise<void> {
  const customMetadata = Object.fromEntries(
    Object.entries(meta).filter(([, v]) => v !== ""),
  );
  await env.ATTACHMENTS.put(key, content, {
    httpMetadata: meta.mimeType === "" ? undefined : { contentType: meta.mimeType },
    customMetadata: Object.keys(customMetadata).length === 0 ? undefined : customMetadata,
  });
}

/** Every attachment body lands under `emailId/att-<i>`; failures are logged, never thrown. */
async function storeAttachments(
  env: Env,
  emailId: string,
  attachments: Attachment[],
): Promise<void> {
  const writes = attachments.map(async (attachment, i) => {
    try {
      await putAttachment(env, `${emailId}/att-${i}`, attachment.content, {
        filename: attachment.filename ?? "",
        mimeType: attachment.mimeType ?? "",
        contentId: attachment.contentId ?? "",
      });
    } catch (error) {
      logWarn("inbound_email_attachment_write_failed", {
        emailId,
        part: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await Promise.all(writes);
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
    stats.unregisteredDrops += 1;
    logWarn("inbound_email_dropped_unregistered", { to, reason: registered });
    message.setReject("Unknown address");
    return;
  }

  // Buffer once: the parse consumes the bytes, and the same buffer is the
  // raw-source dump on parse failure. A stream that errors mid-read lands
  // in the same flag-and-store fallback as unparseable content.
  let raw: ArrayBuffer | null = null;
  try {
    raw = await new Response(message.raw).arrayBuffer();
  } catch (error) {
    logWarn("inbound_email_raw_read_failed", {
      to,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed = null;
  if (raw !== null) {
    try {
      parsed = await PostalMime.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (parsed !== null) {
    const from =
      firstValidAddress(firstMailboxAddress(parsed.from), envelopeAddress(message.from ?? "")) ??
      "unknown@unknown.invalid";
    const input: AddEmailInput = {
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
    };
    const emailId = await storeEmail(env, to, input);
    if (emailId !== null) {
      stats.stored += 1;
      const writes = storeAttachments(env, emailId, parsed.attachments);
      ctx?.waitUntil?.(writes);
      await writes;
    }
    return;
  }

  // Parse failure: keep the raw Subject verbatim, flag the record, and dump
  // the untouched source to R2 — the mail is stored, never crashed on.
  stats.parseFailed += 1;
  const rawSubject = message.headers?.get("subject")?.trim() || EMPTY_SUBJECT;
  const from = firstValidAddress(
    envelopeAddress(message.headers?.get("from") ?? ""),
    envelopeAddress(message.from ?? ""),
  ) ?? "unknown@unknown.invalid";
  const emailId = await storeEmail(env, to, {
    direction: "inbound",
    from_addr: from,
    to_addr: to,
    subject: rawSubject,
    body_text: `${PARSE_FAILED_FLAG} postal-mime could not parse this message; raw source preserved in the attachments bucket as raw-source.`,
    message_id: message.headers?.get("message-id") ?? undefined,
    in_reply_to: message.headers?.get("in-reply-to") ?? undefined,
    references: splitMessageIds(message.headers?.get("references") ?? undefined),
  });
  if (emailId !== null) {
    stats.stored += 1;
  }
  if (emailId !== null && raw !== null) {
    const write = env.ATTACHMENTS.put(`${emailId}/raw-source`, raw, {
      httpMetadata: { contentType: "message/rfc822" },
    }).catch((error: unknown) => {
      logWarn("inbound_email_raw_source_write_failed", {
        emailId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    ctx?.waitUntil?.(write);
    await write;
  }
}
