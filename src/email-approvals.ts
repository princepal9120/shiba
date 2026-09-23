/**
 * Email approval bridge (megaplan task 7). Task 6's send/delete tools
 * never execute the action they name — they freeze the requested
 * operation into an {@link EmailApprovalRequest} and enqueue it here as
 * a pending approval on the shared "default" orchestrator, so the same
 * Slack-card / dashboard resolve path releases it verbatim on approve.
 *
 * The frozen payload is authoritative: the executor routes and sends
 * against `record.payload` alone — a queued draft is immutable by then
 * anyway, so the send path never re-reads it.
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { mailboxStub, registeredMailbox } from "./mailbox-do.js";
import { ADDRESS_RE, randomHex } from "./mailbox-store.js";
import type { PendingApproval } from "./pending-approvals.js";
import { InputError } from "./security.js";

// The shared orchestrator instance name — slack-routes.ts exports it as
// ORCHESTRATOR_NAME, but importing it here would close a type-level
// cycle (env.CodingOrchestrator → orchestrator → this → slack-routes →
// env.CodingOrchestrator) that blows past TS's instantiation depth.
const ORCHESTRATOR_NAME = "default";

/** Operations the email executor knows how to release. */
export type EmailApprovalKind = "email_send" | "email_delete";

export interface EmailApprovalRequest {
  kind: EmailApprovalKind;
  /** Registered mailbox address — also the owning Mailbox stub. */
  mailbox: string;
  /**
   * Frozen executor input: `{to_addr, subject, body_text, thread_id?,
   * draft_id?, in_reply_to_email_id?}` for `email_send`,
   * `{email_id, subject?, from_addr?}` for `email_delete`. The approve
   * path executes this payload exactly as written — never caller-
   * supplied at release time.
   */
  payload: Record<string, unknown>;
}

export interface EmailApprovalResult {
  approval_id: string;
}

/**
 * Thrown when the send binding transmitted but the bookkeeping after it
 * (outbound copy insert, draft `sent` mark) failed. Callers stamp the
 * record `executed` with the copy failure noted — never `failed`: the
 * mail provably went out, and `failed` would contradict the draft's
 * `sent` mark and invite a re-approval double-send.
 */
export class PostTransmitError extends Error {
  constructor(cause: Error) {
    super(cause.message);
    this.name = "PostTransmitError";
  }
}

/**
 * Whether the approval bridge is live for outbound sends. The queue
 * path itself is always wired; the only optional piece is the
 * `send_email` binding — callers that lock state behind a queued send
 * (the dashboard's draft send, which flips a draft to "queued") must
 * refuse while it is unset rather than strand a queued draft behind an
 * approval that can never execute.
 */
export function emailApprovalBridgeReady(env: Env): boolean {
  return env.SEND_EMAIL !== undefined;
}

/**
 * Queue the frozen request as a pending approval on the shared
 * orchestrator — the same `/api/runs` route the automations use, so the
 * dashboard's Approvals tab lists it like any other approval through
 * `GET /api/approvals`. `threadKey` stays `"default"`: the resolve
 * surface probes the shared DO by that name, so the pointer must name
 * the instance that holds the record.
 */
export async function queueEmailApproval(
  env: Env,
  request: EmailApprovalRequest,
): Promise<EmailApprovalResult> {
  const stub = await getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME);
  const queued = await stub.fetch(
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: request.kind,
        mailbox: request.mailbox,
        payload: request.payload,
        threadKey: ORCHESTRATOR_NAME,
      }),
    }),
  );
  if (!queued.ok) {
    throw new Error(`Email approval queue failed (${queued.status}).`);
  }
  const body = (await queued.json().catch(() => ({}))) as { approvalId?: string };
  if (!body.approvalId) {
    throw new Error("Orchestrator did not return an approval id.");
  }
  return { approval_id: body.approvalId };
}

type MailboxFetch = { fetch: (request: Request) => Promise<Response> };

function requirePayloadField(fields: Record<string, unknown>, field: string): string {
  const value = fields[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`email approval payload requires non-empty string field "${field}".`);
  }
  return value;
}

async function mailboxCall(stub: MailboxFetch, path: string, init: RequestInit): Promise<Response> {
  const response = await stub.fetch(
    new Request(`https://internal/internal/mailbox${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    }),
  );
  if (!response.ok) {
    throw new Error(`Mailbox ${init.method ?? "GET"} ${path} failed (${response.status}).`);
  }
  return response;
}

/**
 * Release a resolved email approval: execute `record.payload` verbatim
 * against the mailbox it was frozen for. The orchestrator calls this
 * after the pointer resolves — replay-guarded there, so each approved
 * approval executes once.
 */
export async function executeEmailApproval(
  env: Env,
  record: PendingApproval,
  opts?: { excludeDraftIds?: string[] },
): Promise<void> {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new InputError(`Email approval ${record.approvalId} has no frozen payload.`);
  }
  const fields = payload as Record<string, unknown>;
  const mailbox = typeof fields.mailbox === "string" ? fields.mailbox : "";
  if (!ADDRESS_RE.test(mailbox)) {
    throw new InputError(`Email approval ${record.approvalId} carries no valid mailbox.`);
  }
  // The same registry invariant intake enforces (orchestrator queue +
  // MCP requireMailbox): a well-formed but unregistered address must
  // never reach the send binding or instantiate a mailbox stub —
  // `idFromName` would otherwise mint DOs at unbounded cardinality.
  // The record's canonical address, not the caller's casing, names the
  // stub and the wire From.
  const registration = await registeredMailbox(env, mailbox);
  if (registration === null) {
    throw new InputError(
      `Email approval ${record.approvalId} mailbox "${mailbox}" is not registered.`,
    );
  }
  const stub = mailboxStub(env, registration.address);
  if (record.kind === "email_send") {
    const progress = { transmitted: false, claimed: false };
    try {
      await sendApprovedEmail(env, stub, registration.address, fields, progress);
    } catch (error) {
      await reconcileQueuedDraft(stub, fields, progress, opts?.excludeDraftIds);
      throw error;
    }
    return;
  }
  if (record.kind === "email_delete") {
    const emailId = requirePayloadField(fields, "email_id").trim();
    const response = await stub.fetch(
      new Request(`https://internal/internal/mailbox/emails/${encodeURIComponent(emailId)}`, {
        method: "DELETE",
      }),
    );
    // An already-deleted row satisfies the payload's goal — idempotent.
    if (!response.ok && response.status !== 404) {
      throw new Error(`Mailbox DELETE /emails/${emailId} failed (${response.status}).`);
    }
    return;
  }
  throw new InputError(
    `Approval ${record.approvalId} kind "${String(record.kind)}" is not an email action.`,
  );
}

/**
 * The mailbox + draft row an email_send record locks, or null when the
 * record holds none (composed sends without a draft, email_delete,
 * malformed payload). Both release paths — the single-shot unqueue and
 * the stale-queued sweep — key on this so they can keep a lock alive
 * while a sibling pending approval still needs it.
 */
export function emailApprovalDraftRef(record: PendingApproval): { mailbox: string; draftId: string } | null {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const fields = payload as Record<string, unknown>;
  const mailbox = typeof fields.mailbox === "string" ? fields.mailbox.toLowerCase() : "";
  const draftId = typeof fields.draft_id === "string" ? fields.draft_id.trim() : "";
  if (draftId === "" || !ADDRESS_RE.test(mailbox)) {
    return null;
  }
  return { mailbox, draftId };
}

/**
 * A rejected email approval releases its queued draft back to editable
 * `"draft"` — without this the row would sit `queued` behind an
 * approval that can never be re-resolved. Best-effort at the call site:
 * a failure here is logged, never fatal to the resolve.
 */
export async function unqueueEmailApprovalDraft(env: Env, record: PendingApproval): Promise<void> {
  const ref = emailApprovalDraftRef(record);
  if (ref === null) {
    return;
  }
  await mailboxCall(mailboxStub(env, ref.mailbox), `/drafts/${encodeURIComponent(ref.draftId)}/unqueue`, {
    method: "POST",
  });
}

/**
 * Restart-recovery seam: frees a `sending` claim the dead attempt left
 * behind. Claims are only minted by the shared orchestrator's dispatch
 * (`queueEmailApproval` pins that instance), and this runs before any
 * new dispatch starts in the DO's fresh lifetime — so a `sending` row
 * found here is provably dead, and unconditional release is the only
 * surface that can reach it (`unqueue` refuses `sending`; the dead
 * attempt's own `release` died with it). Returns true only when the row
 * was freed — false means it was never `sending`, which the caller's
 * re-drive adjudicates (`queued` sends, `sent` dedupes, `draft`/missing
 * fails). Anything but a refusal is a real failure and throws.
 */
export async function releaseRestartedDraftClaim(env: Env, record: PendingApproval): Promise<boolean> {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const fields = payload as Record<string, unknown>;
  const mailbox = typeof fields.mailbox === "string" ? fields.mailbox : "";
  const draftId = typeof fields.draft_id === "string" ? fields.draft_id.trim() : "";
  if (draftId === "" || !ADDRESS_RE.test(mailbox)) {
    return false;
  }
  const response = await mailboxStub(env, mailbox).fetch(
    new Request(`https://internal/internal/mailbox/drafts/${encodeURIComponent(draftId)}/release`, {
      method: "POST",
    }),
  );
  if (response.ok) {
    return true;
  }
  if (response.status === 400 || response.status === 404) {
    return false;
  }
  throw new Error(`Mailbox POST /drafts/${draftId}/release failed (${response.status}).`);
}

/**
 * Reconcile the queued draft after a failed send. If the send went
 * out, the draft lands in `"sent"` — re-queueing would double-send.
 * If it never left, the row goes back to `"draft"` so the user can
 * edit and re-queue: `release` frees the executor's own claim
 * (`sending` → `draft`), `unqueue` frees a row the claim never took
 * (`queued` → `draft`). Releasing only when this executor claimed
 * keeps a failed approval from stealing a live sibling's `sending`
 * row. Best-effort: the original error propagates either way, so a
 * failed reconcile is logged, not thrown.
 */
async function reconcileQueuedDraft(
  stub: MailboxFetch,
  fields: Record<string, unknown>,
  progress: { transmitted: boolean; claimed: boolean },
  excludeDraftIds?: string[],
): Promise<void> {
  const draftId = typeof fields.draft_id === "string" ? fields.draft_id.trim() : "";
  if (draftId === "") {
    return;
  }
  const seam = progress.transmitted ? "sent" : progress.claimed ? "release" : "unqueue";
  try {
    if (!progress.transmitted && !progress.claimed) {
      // Claim refused: the row may sit `sending` behind a dead attempt
      // (restart between claim and wire) that `unqueue` cannot reach.
      // The sweep frees only provably-dead claims — but its age check
      // cannot see a live sibling approval minted after the row queued,
      // so the caller's live-approval ids must ride along or the sweep
      // frees a lock a pending sibling still owns.
      await mailboxCall(stub, `/drafts/release-stale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exclude_ids: excludeDraftIds ?? [] }),
      });
    }
    await mailboxCall(stub, `/drafts/${encodeURIComponent(draftId)}/${seam}`, {
      method: "POST",
    });
  } catch (error) {
    console.warn(
      `email draft reconcile failed ${JSON.stringify({
        draft_id: draftId,
        transmitted: progress.transmitted,
        error: error instanceof Error ? error.message : String(error),
      })}`,
    );
  }
}

/**
 * Send the frozen payload, then record the evidence trail it leaves.
 * `progress.transmitted` flips once `SEND_EMAIL.send` resolves — the
 * caller reconciles the draft to `"sent"` on post-transmit failures and
 * back to `"draft"` when the payload never left.
 */
async function sendApprovedEmail(
  env: Env,
  stub: MailboxFetch,
  mailbox: string,
  fields: Record<string, unknown>,
  progress: { transmitted: boolean; claimed: boolean },
): Promise<void> {
  const toAddr = requirePayloadField(fields, "to_addr").trim();
  const subject = requirePayloadField(fields, "subject");
  const bodyText = requirePayloadField(fields, "body_text");
  if (!env.SEND_EMAIL) {
    throw new Error("SEND_EMAIL binding is not configured — enable Email Sending.");
  }
  const draftId = typeof fields.draft_id === "string" ? fields.draft_id.trim() : "";
  if (draftId !== "") {
    // Claim the draft before anything reaches the wire: the `queued` →
    // `sending` CAS dedupes the live-approval race a post-send mark
    // cannot — two approvals frozen on one draft stop competing here.
    const claimed = await claimDraftForSend(stub, draftId, fields);
    if (!claimed) {
      // The draft already carries `sent` AND its row matches this
      // payload byte-for-byte — a sibling approval sent exactly this
      // content, so `executed` is truthful without a second copy.
      return;
    }
    progress.claimed = true;
  }
  // `send_reply` freezes the parent's internal id as in_reply_to_email_id;
  // the wire send must quote its RFC822 Message-ID in In-Reply-To/
  // References or the approved reply will not thread in mail clients.
  const threading = await replyThreading(stub, fields);
  // The frozen payload is authoritative: the send input is exactly what
  // the approver reviewed; no draft row is re-read at release time.
  await env.SEND_EMAIL.send({
    from: mailbox,
    to: toAddr,
    subject,
    text: bodyText,
    ...(threading !== undefined ? { headers: threading.headers } : {}),
  });
  progress.transmitted = true;
  // Everything below is bookkeeping over a mail that already left: a
  // failure here must not read as "send failed" upstream (the draft
  // reconciles to `sent`, so `failed` would leave two durable stores
  // disagreeing on whether the mail went out). The copy carries a
  // deterministic dedup key — one retry of the block is safe because a
  // repeated insert folds onto the first copy rather than duplicating.
  const copyMessageId = `shiba-send:${draftId !== "" ? draftId : randomHex(12)}`;
  const recordSend = async (): Promise<void> => {
    // The outbound copy lands next to the conversation it answers — the
    // wire-level in_reply_to re-derives the parent thread when the frozen
    // payload carried no thread_id.
    const threadId =
      typeof fields.thread_id === "string" && fields.thread_id.trim() !== ""
        ? fields.thread_id
        : undefined;
    await mailboxCall(stub, "/emails", {
      method: "POST",
      body: JSON.stringify({
        direction: "outbound",
        from_addr: mailbox,
        to_addr: toAddr,
        subject,
        body_text: bodyText,
        status: "sent",
        message_id: copyMessageId,
        ...(threadId !== undefined ? { thread_id: threadId } : {}),
        ...(threading !== undefined ? { in_reply_to: threading.inReplyTo } : {}),
      }),
    });
    // The sent mark proves the send happened only through this seam —
    // `/drafts/:id/sent` refuses anything but a queued or claimed row.
    if (draftId !== "") {
      await mailboxCall(stub, `/drafts/${encodeURIComponent(draftId)}/sent`, { method: "POST" });
    }
  };
  try {
    await recordSend();
  } catch (firstError) {
    try {
      // One immediate retry: a transient stub error here loses the sent
      // copy for good — the draft still reconciles to `sent`, so the only
      // evidence the mail ever left would be the provider's own log.
      await recordSend();
    } catch {
      throw new PostTransmitError(
        firstError instanceof Error ? firstError : new Error(String(firstError)),
      );
    }
  }
}

/**
 * `queued` → `sending` claim inside the mailbox DO. Returns false only
 * when the draft already carries `sent` AND its row content matches
 * this payload — proof the sent copy is exactly what this approval
 * froze, so the record resolves `executed` without a second copy on
 * the wire. A `sent` row carrying DIFFERENT content means a sibling
 * approval sent its own payload, not this one: `executed` would be a
 * mis-stamp, so the record fails instead. Intake already refuses mints
 * whose payload diverges from the named draft — this check is the
 * durable guard for records minted before that binding or raced past
 * it. Every other non-queued state (still `draft`, a live sibling's
 * `sending`, `discarded`, a missing row) means this approval can no
 * longer be honored and throws.
 */
async function claimDraftForSend(
  stub: MailboxFetch,
  draftId: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  try {
    await mailboxCall(stub, `/drafts/${encodeURIComponent(draftId)}/claim`, {
      method: "POST",
    });
    return true;
  } catch {
    const response = await stub.fetch(
      new Request(
        `https://internal/internal/mailbox/drafts/${encodeURIComponent(draftId)}`,
      ),
    );
    const draft = response.ok
      ? (((await response.json()) as { draft?: Record<string, unknown> }).draft ?? undefined)
      : undefined;
    const status = draft?.status as string | undefined;
    if (status === "sent") {
      const same =
        typeof draft?.to_addr === "string" &&
        draft.to_addr.trim() === String(fields.to_addr ?? "").trim() &&
        draft.subject === fields.subject &&
        draft.body_text === fields.body_text;
      if (same) {
        return false;
      }
      throw new InputError(
        `Draft ${draftId} was already sent with different content — this approval's payload never went out.`,
      );
    }
    throw new InputError(
      `Draft ${draftId} is ${JSON.stringify(status ?? "unknown")} — only a queued draft can be claimed for sending.`,
    );
  }
}

interface ReplyThreading {
  /** RFC822 headers to send on the wire (`In-Reply-To` + `References`). */
  headers: Record<string, string>;
  /** The bracketed parent Message-ID — also recorded on the stored copy. */
  inReplyTo: string;
}

/**
 * Wire threading metadata for a frozen reply. `send_reply` freezes the
 * parent's internal email id as `in_reply_to_email_id`; mail clients
 * thread on its RFC822 Message-ID, which lives in the mailbox's
 * `email_ids` map (exposed as `message_ids` on `GET /emails/:id`).
 * Returns undefined when the payload is not a reply or the parent's id
 * is unknowable (a deleted row, an inbound message that carried no
 * Message-ID header) — a reply still delivers unthreaded rather than
 * vetoing the approved send.
 */
async function replyThreading(
  stub: MailboxFetch,
  fields: Record<string, unknown>,
): Promise<ReplyThreading | undefined> {
  const parentEmailId =
    typeof fields.in_reply_to_email_id === "string"
      ? fields.in_reply_to_email_id.trim()
      : "";
  if (parentEmailId === "") {
    return undefined;
  }
  let parentIds: string[] = [];
  try {
    const response = await stub.fetch(
      new Request(
        `https://internal/internal/mailbox/emails/${encodeURIComponent(parentEmailId)}`,
      ),
    );
    if (response.ok) {
      const body = (await response.json()) as { message_ids?: unknown };
      parentIds = Array.isArray(body.message_ids)
        ? body.message_ids.filter(
            (id): id is string => typeof id === "string" && id.trim() !== "",
          )
        : [];
    }
  } catch (error) {
    console.warn(
      `email reply threading lookup failed ${JSON.stringify({
        email_id: parentEmailId,
        error: error instanceof Error ? error.message : String(error),
      })}`,
    );
  }
  const raw = parentIds[0]?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const bracketed = raw.startsWith("<") ? raw : `<${raw}>`;
  return {
    headers: { "In-Reply-To": bracketed, References: bracketed },
    inReplyTo: bracketed,
  };
}
