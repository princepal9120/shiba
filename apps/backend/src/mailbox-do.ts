/**
 * Mailbox Durable Object (megaplan task 2): thin JSON-over-fetch surface
 * over {@link MailboxStore} on `ctx.storage.sql`.
 *
 * Instance model: one stub per mailbox address
 * (`env.Mailbox.idFromName(address)`) owns that mailbox's emails, threads,
 * and drafts. A reserved directory instance
 * (`idFromName(MAILBOX_DIRECTORY_NAME)` — not an email address, so it can
 * never collide with a real stub) holds the global `mailboxes` registry:
 * the single source of truth for which addresses exist, which is what makes
 * `listMailboxes` / `isRegistered` answerable across per-address instances.
 * Registry routes are served only by the directory; `GET
 * /internal/mailbox/mailbox` on an address stub delegates its registration
 * lookup to the directory so the meta answer is always consistent.
 *
 * All routes live under `/internal/mailbox/*` and are reachable only through
 * `stub.fetch` calls inside the worker — index.ts returns 404 for external
 * `/internal/*` paths, so none of this is a public surface.
 */
import type { Env } from "./env.js";
import {
  DRAFT_STATUSES,
  EMAIL_STATUSES,
  MailboxStore,
  type AddEmailInput,
  type CreateDraftInput,
  type EmailAttachmentInput,
  type EmailStatus,
  type MailboxRecord,
  type SqlExec,
  type SqlRow,
  type UpdateDraftInput,
} from "./mailbox-store.js";
import { APPROVAL_TTL_MS } from "./pending-approvals.js";
import { InputError } from "./security.js";

/**
 * Reserved DO name for the shared mailbox registry. Chosen to fail the
 * store's email-address validation, so no real mailbox can claim it.
 */
export const MAILBOX_DIRECTORY_NAME = "__directory__";

const ROUTE_PREFIX = "/internal/mailbox";

/** A `sending` row untouched this long is a dead claim — a live send
 * completes or fails in seconds. */
const STALE_SENDING_MS = 10 * 60 * 1000;

/** Grace beyond the approval TTL: the queue CAS stamps
 * `drafts.updated_at` strictly before the mint writes the approval's
 * `createdAt`, and the two clocks can skew — TTL alone would make the
 * row sweepable that gap before its approval actually expires, and an
 * approve landing inside the window would find the lock already freed.
 * The buffer must only exceed any plausible queue→mint latency; a mint
 * stalled past it never happened anyway. */
const STALE_QUEUED_GRACE_MS = 5 * 60 * 1000;

/** A `queued` row untouched this long belongs to an approval that can
 * no longer resolve: queue lands before the mint, so its age is at
 * least the approval's, and no approval outlives its TTL. */
const STALE_QUEUED_MS = APPROVAL_TTL_MS + STALE_QUEUED_GRACE_MS;

/** Per-address stub — the unit every mailbox-scoped call goes through. */
export function mailboxStub(env: Env, address: string): DurableObjectStub {
  // Normalize like the store's registry lookups so every spelling of an
  // address resolves to the same DO instance (header-parsed recipients
  // arrive with arbitrary case).
  return env.Mailbox.get(env.Mailbox.idFromName(address.trim().toLowerCase()));
}

/** Shared registry stub — registration, enumeration, and `isRegistered`. */
export function mailboxDirectoryStub(env: Env): DurableObjectStub {
  return mailboxStub(env, MAILBOX_DIRECTORY_NAME);
}

/**
 * Worker-side registry probe — the directory instance is the single
 * source of truth for "is this address registered". Every gate that
 * acts on a mailbox (MCP tools' `requireMailbox`, the `/api/runs`
 * approval intake) enforces the same invariant through this one read;
 * a directory failure throws so callers fail closed, never open.
 */
export async function registeredMailbox(env: Env, address: string): Promise<MailboxRecord | null> {
  const response = await mailboxDirectoryStub(env).fetch(
    new Request(
      `https://internal${ROUTE_PREFIX}/mailboxes/${encodeURIComponent(address)}`,
    ),
  );
  if (!response.ok) {
    throw new Error(`Mailbox directory lookup failed (${response.status}).`);
  }
  const body = (await response.json()) as { mailbox?: MailboxRecord | null };
  return body.mailbox ?? null;
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function notFound(what = "Not found."): Response {
  return json({ error: what }, { status: 404 });
}

function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`${field} must be a non-empty string.`);
  }
  return value;
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputError(`${field} must be a finite number.`);
  }
  return value;
}

/** Attachment manifest entries — shape-checked here, value-checked in the store. */
function optAttachmentList(value: unknown): EmailAttachmentInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new InputError("attachments must be an array of objects.");
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new InputError("attachments entries must be objects.");
    }
    const attachment = entry as Record<string, unknown>;
    return {
      part_id: requiredString(attachment.part_id, "attachments[].part_id"),
      filename: optString(attachment.filename),
      mime_type: optString(attachment.mime_type),
      size: requiredNumber(attachment.size, "attachments[].size"),
      content_id: optString(attachment.content_id),
      r2_key: requiredString(attachment.r2_key, "attachments[].r2_key"),
    };
  });
}

function optStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

function enumParam<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new InputError(`${field} must be one of ${allowed.join(", ")}.`);
  }
  return raw as T;
}

function limitParam(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  // Non-numeric limits parse to NaN, which the store clamps to its default
  // page — matching the list APIs' non-finite behavior.
  return Number(raw);
}

/** Path segment decode — a malformed %escape is a 400, not a 500. */
function pathParam(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    throw new InputError("Path parameter is not valid percent-encoding.");
  }
}

export class Mailbox {
  private readonly store: MailboxStore;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    const exec: SqlExec = (sql, ...params) =>
      ctx.storage.sql.exec(sql, ...params).toArray() as unknown as SqlRow[];
    this.store = new MailboxStore(exec, (fn) => ctx.storage.transactionSync(fn));
    ctx.blockConcurrencyWhile(async () => {
      this.store.init();
    });
  }

  /** The `idFromName` input this stub was created with ("" for unique ids). */
  private get address(): string {
    return this.ctx.id.name ?? "";
  }

  private get isDirectory(): boolean {
    return this.address === MAILBOX_DIRECTORY_NAME;
  }

  private async jsonBody(request: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new InputError("Request body is not valid JSON.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new InputError("Request body must be a JSON object.");
    }
    return body as Record<string, unknown>;
  }

  /**
   * This mailbox's registry row, resolved through the directory instance so
   * `registered`/`mailbox` in meta are authoritative regardless of which
   * stub answers. Address stubs keep no local `mailboxes` row at all —
   * a second copy would only ever disagree with the registry.
   */
  private async registrationRecord(): Promise<MailboxRecord | null> {
    if (this.isDirectory || this.address === "") {
      return null;
    }
    const res = await mailboxDirectoryStub(this.env).fetch(
      new Request(
        `https://internal${ROUTE_PREFIX}/mailboxes/${encodeURIComponent(this.address)}`,
      ),
    );
    if (!res.ok) {
      throw new Error(`Mailbox directory lookup failed (${res.status}).`);
    }
    const body = (await res.json()) as { mailbox?: MailboxRecord | null };
    return body.mailbox ?? null;
  }

  private async mailboxMeta(): Promise<Response> {
    const registration = await this.registrationRecord();
    return json({
      address: this.address,
      registered: registration !== null,
      mailbox: registration,
      stats: this.store.mailboxStats(),
      // The directory instance is the registry — surface its full listing
      // on the same meta shape so callers need one route, not two.
      ...(this.isDirectory ? { mailboxes: this.store.listMailboxes() } : {}),
    });
  }

  private async registry(request: Request, seg: string[]): Promise<Response> {
    if (!this.isDirectory) {
      return badRequest(
        `Mailbox registry is served by the ${MAILBOX_DIRECTORY_NAME} instance.`,
      );
    }
    if (seg.length === 1) {
      if (request.method === "GET") {
        return json({ mailboxes: this.store.listMailboxes() });
      }
      if (request.method === "POST") {
        const body = await this.jsonBody(request);
        const mailbox = this.store.registerMailbox({
          address: requiredString(body.address, "address"),
          label: optString(body.label),
          agent: body.agent === null ? null : body.agent === undefined ? undefined : requiredString(body.agent, "agent"),
        });
        return json({ mailbox }, { status: 201 });
      }
      return json({ error: "Method not allowed." }, { status: 405 });
    }
    if (seg.length === 2) {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      const address = pathParam(seg[1]);
      const mailbox = this.store.getMailbox(address);
      return json({ mailbox, registered: mailbox !== null });
    }
    return notFound();
  }

  private async emails(request: Request, url: URL, seg: string[]): Promise<Response> {
    if (seg.length === 1) {
      if (request.method === "GET") {
        const status = enumParam(url.searchParams.get("status"), EMAIL_STATUSES, "status");
        const mailbox = url.searchParams.get("mailbox") ?? undefined;
        const limit = limitParam(url.searchParams.get("limit"));
        return json({ emails: this.store.listEmails({ status, mailbox, limit }) });
      }
      if (request.method === "POST") {
        const body = await this.jsonBody(request);
        const input: AddEmailInput = {
          direction: requiredString(body.direction, "direction") as AddEmailInput["direction"],
          from_addr: requiredString(body.from_addr, "from_addr"),
          to_addr: requiredString(body.to_addr, "to_addr"),
          subject: requiredString(body.subject, "subject"),
          body_text: optString(body.body_text) ?? null,
          body_html: optString(body.body_html) ?? null,
          status: optString(body.status) as EmailStatus | undefined,
          created_at: optNumber(body.created_at),
          message_id: optString(body.message_id),
          in_reply_to: optString(body.in_reply_to),
          references: optStringList(body.references),
          thread_id: optString(body.thread_id),
          id: optString(body.id),
          attachments: optAttachmentList(body.attachments),
        };
        return json({ email: this.store.addEmail(input) }, { status: 201 });
      }
      return json({ error: "Method not allowed." }, { status: 405 });
    }
    if (seg.length === 2 && seg[1] === "search") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      const query = url.searchParams.get("q") ?? "";
      const mailbox = url.searchParams.get("mailbox") ?? undefined;
      const limit = limitParam(url.searchParams.get("limit"));
      return json({ emails: this.store.searchEmails(query, { mailbox, limit }) });
    }
    const id = pathParam(seg[1]);
    if (seg.length === 2) {
      if (request.method === "GET") {
        const email = this.store.getEmail(id);
        // The manifest rides along so consumers never list the R2 bucket
        // (or HEAD its objects) to learn a part's name/type/size/location;
        // `message_ids` exposes the RFC822 ids a wire reply must quote
        // back to thread onto this email.
        return email
          ? json({
              email,
              attachments: this.store.getAttachments(id),
              message_ids: this.store.messageIdsFor(id),
            })
          : notFound("Email not found.");
      }
      if (request.method === "DELETE") {
        // The manifest rows are the only map to this email's R2 bodies —
        // capture the keys before the hard delete removes them, then drop
        // the objects so no `emailId/*` blob outlives the record that
        // pointed at it.
        const keys = this.store.getAttachments(id).map((a) => a.r2_key);
        if (!this.store.deleteEmail(id)) {
          return notFound("Email not found.");
        }
        await Promise.all(
          keys.map(async (key) => {
            try {
              await this.env.ATTACHMENTS.delete(key);
            } catch (error) {
              // Best-effort: a failed delete orphans one object — logged,
              // never folded into a 500 that would misreport the row as
              // undeleted.
              console.warn(
                `mailbox_attachment_delete_failed ${JSON.stringify({
                  key,
                  error: error instanceof Error ? error.message : String(error),
                })}`,
              );
            }
          }),
        );
        return json({ ok: true, id });
      }
      return json({ error: "Method not allowed." }, { status: 405 });
    }
    if (seg.length === 3 && seg[2] === "read") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      const changed = this.store.markRead(id);
      const email = this.store.getEmail(id);
      // `changed` is reported rather than treated as an error: a re-read of
      // an already-read email is idempotent, not a failure.
      return email ? json({ email, changed }) : notFound("Email not found.");
    }
    if (seg.length === 3 && seg[2] === "move") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      const body = await this.jsonBody(request);
      const email = this.store.moveStatus(id, requiredString(body.status, "status") as EmailStatus);
      return email ? json({ email }) : notFound("Email not found.");
    }
    return notFound();
  }

  private async drafts(request: Request, url: URL, seg: string[]): Promise<Response> {
    if (seg.length === 1) {
      if (request.method === "GET") {
        const status = enumParam(url.searchParams.get("status"), DRAFT_STATUSES, "status");
        const limit = limitParam(url.searchParams.get("limit"));
        return json({ drafts: this.store.listDrafts({ status, limit }) });
      }
      if (request.method === "POST") {
        const body = await this.jsonBody(request);
        const input: CreateDraftInput = {
          to_addr: requiredString(body.to_addr, "to_addr"),
          subject: requiredString(body.subject, "subject"),
          body_text: requiredString(body.body_text, "body_text"),
          thread_id: optString(body.thread_id),
          in_reply_to_email_id: optString(body.in_reply_to_email_id),
        };
        return json({ draft: this.store.createDraft(input) }, { status: 201 });
      }
      return json({ error: "Method not allowed." }, { status: 405 });
    }
    // Checked before the generic /drafts/:id branch — "release-stale"
    // would otherwise be read as a draft id and the route never match.
    if (seg.length === 2 && seg[1] === "release-stale") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      // Recovery seam: a `sending` row older than the threshold is a
      // dead claim — a live send holds `sending` for seconds — and a
      // `queued` row older than the approval TTL plus the mint-latency
      // grace belongs to a decided or expired approval whose single-shot
      // release missed. The sweep frees only rows no live path can
      // still be holding. Optional `{exclude_ids}` names drafts a live
      // pending approval still owns — the age check cannot see a
      // sibling approval minted after the row was queued. The body is
      // parsed tolerantly: legacy callers POST with no body.
      const rawBody = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const excludeIds = optStringList(rawBody.exclude_ids);
      const now = Date.now();
      return json({
        drafts: [
          ...this.store.releaseStaleSendingDrafts(now - STALE_SENDING_MS, now),
          ...this.store.releaseStaleQueuedDrafts(
            now - STALE_QUEUED_MS,
            now,
            excludeIds === undefined ? undefined : new Set(excludeIds),
          ),
        ],
      });
    }
    if (seg.length === 2) {
      const id = pathParam(seg[1]);
      if (request.method === "GET") {
        const draft = this.store.getDraft(id);
        return draft ? json({ draft }) : notFound("Draft not found.");
      }
      if (request.method !== "PATCH") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      const body = await this.jsonBody(request);
      const input: UpdateDraftInput = {
        to_addr: optString(body.to_addr),
        subject: optString(body.subject),
        body_text: optString(body.body_text),
        status: optString(body.status) as UpdateDraftInput["status"],
      };
      const draft = this.store.updateDraft(id, input);
      return draft ? json({ draft }) : notFound("Draft not found.");
    }
    if (seg.length === 3 && seg[2] === "claim") {
      const id = pathParam(seg[1]);
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      // Approval-executor seam: the only route that may set `sending`.
      const draft = this.store.claimDraftSend(id);
      return draft ? json({ draft }) : notFound("Draft not found.");
    }
    if (seg.length === 3 && seg[2] === "release") {
      const id = pathParam(seg[1]);
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      // Compensating seam: a claimed-but-never-sent draft returns to
      // editable `draft` instead of stranding behind `sending`.
      const draft = this.store.releaseDraftClaim(id);
      return draft ? json({ draft }) : notFound("Draft not found.");
    }
    if (seg.length === 3 && seg[2] === "queue") {
      const id = pathParam(seg[1]);
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      // Approval-gate seam: the only route that may set `queued`.
      const draft = this.store.markDraftQueued(id);
      return draft ? json({ draft }) : notFound("Draft not found.");
    }
    if (seg.length === 3 && seg[2] === "sent") {
      const id = pathParam(seg[1]);
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      // Approval-executor seam: the only route that may set `sent`.
      const draft = this.store.markDraftSent(id);
      return draft ? json({ draft }) : notFound("Draft not found.");
    }
    if (seg.length === 3 && seg[2] === "unqueue") {
      const id = pathParam(seg[1]);
      if (request.method !== "POST") {
        return json({ error: "Method not allowed." }, { status: 405 });
      }
      // Compensating seam: rejection or a failed mint/execute returns the
      // draft to editable `draft` instead of stranding it behind `queued`.
      const draft = this.store.unqueueDraft(id);
      return draft ? json({ draft }) : notFound("Draft not found.");
    }
    return notFound();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      return notFound();
    }
    const seg = url.pathname
      .slice(ROUTE_PREFIX.length)
      .split("/")
      .filter((s) => s !== "");
    try {
      // The directory instance holds only the registry — a mail write
      // through it lands in a store no per-address stub ever reads.
      if (
        this.isDirectory &&
        request.method !== "GET" &&
        (seg[0] === "emails" || seg[0] === "drafts")
      ) {
        return badRequest(
          `Mail data is served by the per-address instance, not ${MAILBOX_DIRECTORY_NAME}.`,
        );
      }
      if (seg[0] === "emails") {
        return await this.emails(request, url, seg);
      }
      if (seg[0] === "threads" && seg.length === 2) {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed." }, { status: 405 });
        }
        const thread = this.store.getThread(pathParam(seg[1]));
        return thread ? json({ thread }) : notFound("Thread not found.");
      }
      if (seg[0] === "drafts") {
        return await this.drafts(request, url, seg);
      }
      if (seg[0] === "mailbox" && seg.length === 1) {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed." }, { status: 405 });
        }
        return await this.mailboxMeta();
      }
      if (seg[0] === "mailboxes") {
        return await this.registry(request, seg);
      }
      return notFound();
    } catch (error) {
      if (error instanceof InputError) {
        return badRequest(error.message);
      }
      throw error;
    }
  }
}
