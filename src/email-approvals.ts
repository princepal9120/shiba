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
import { mailboxStub } from "./mailbox-do.js";
import { ADDRESS_RE } from "./mailbox-store.js";
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
export async function executeEmailApproval(env: Env, record: PendingApproval): Promise<void> {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new InputError(`Email approval ${record.approvalId} has no frozen payload.`);
  }
  const fields = payload as Record<string, unknown>;
  const mailbox = typeof fields.mailbox === "string" ? fields.mailbox : "";
  if (!ADDRESS_RE.test(mailbox)) {
    throw new InputError(`Email approval ${record.approvalId} carries no valid mailbox.`);
  }
  const stub = mailboxStub(env, mailbox);
  if (record.kind === "email_send") {
    const progress = { transmitted: false };
    try {
      await sendApprovedEmail(env, stub, mailbox, fields, progress);
    } catch (error) {
      await reconcileQueuedDraft(stub, fields, progress.transmitted);
      throw error;
    }
    return;
  }
  if (record.kind === "email_delete") {
    const emailId = requirePayloadField(fields, "email_id");
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
 * A rejected email approval releases its queued draft back to editable
 * `"draft"` — without this the row would sit `queued` behind an
 * approval that can never be re-resolved. Best-effort at the call site:
 * a failure here is logged, never fatal to the resolve.
 */
export async function unqueueEmailApprovalDraft(env: Env, record: PendingApproval): Promise<void> {
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return;
  }
  const fields = payload as Record<string, unknown>;
  const mailbox = typeof fields.mailbox === "string" ? fields.mailbox : "";
  const draftId = typeof fields.draft_id === "string" ? fields.draft_id.trim() : "";
  if (draftId === "" || !ADDRESS_RE.test(mailbox)) {
    return;
  }
  await mailboxCall(mailboxStub(env, mailbox), `/drafts/${encodeURIComponent(draftId)}/unqueue`, {
    method: "POST",
  });
}

/**
 * Reconcile the queued draft after a failed send. If the send never
 * left, the draft goes back to `"draft"` so the user can edit and
 * re-queue; if it went out, reconcile it to `"sent"` — re-queueing
 * would double-send. Best-effort: the original error propagates either
 * way, so a failed reconcile is logged, not thrown.
 */
async function reconcileQueuedDraft(
  stub: MailboxFetch,
  fields: Record<string, unknown>,
  transmitted: boolean,
): Promise<void> {
  const draftId = typeof fields.draft_id === "string" ? fields.draft_id.trim() : "";
  if (draftId === "") {
    return;
  }
  try {
    await mailboxCall(
      stub,
      `/drafts/${encodeURIComponent(draftId)}/${transmitted ? "sent" : "unqueue"}`,
      { method: "POST" },
    );
  } catch (error) {
    console.warn(
      `email draft reconcile failed ${JSON.stringify({
        draft_id: draftId,
        transmitted,
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
  progress: { transmitted: boolean },
): Promise<void> {
  const toAddr = requirePayloadField(fields, "to_addr");
  const subject = requirePayloadField(fields, "subject");
  const bodyText = requirePayloadField(fields, "body_text");
  if (!env.SEND_EMAIL) {
    throw new Error("SEND_EMAIL binding is not configured — enable Email Sending.");
  }
  // The frozen payload is authoritative: the send input is exactly what
  // the approver reviewed; no draft row is re-read at release time.
  await env.SEND_EMAIL.send({ from: mailbox, to: toAddr, subject, text: bodyText });
  progress.transmitted = true;
  // The outbound copy lands next to the conversation it answers.
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
      ...(threadId !== undefined ? { thread_id: threadId } : {}),
    }),
  });
  // A queued draft proves its send happened only through this seam —
  // `/drafts/:id/sent` refuses anything but a queued row.
  const draftId = typeof fields.draft_id === "string" ? fields.draft_id.trim() : "";
  if (draftId !== "") {
    await mailboxCall(stub, `/drafts/${encodeURIComponent(draftId)}/sent`, { method: "POST" });
  }
}
