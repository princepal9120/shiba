/**
 * Email approval bridge seam (megaplan tasks 6→7). Task 6's send/delete
 * tools never execute the action they name — they freeze the requested
 * operation into an {@link EmailApprovalRequest} and enqueue it here, so
 * the orchestrator's approval path (Slack card, Approvals dashboard tab)
 * can release it to the email executor verbatim on approve.
 *
 * Task 7 lands the real bridge: a `PendingApproval` record carrying
 * `kind`/`payload` resolved through the internal queue route. Until then
 * this is the sanctioned "not wired" stub the T6 brief allows — it mints
 * the id the tool contract returns and logs loudly, so a queued-but-
 * unstored approval is visible in traces rather than silently dropped.
 */
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

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
 * Whether the approval bridge is live. Until T7 swaps the stub below for
 * the real PendingApproval insert this returns false, and callers that
 * would lock state behind a queued approval — the dashboard's draft send,
 * which irreversibly flips a draft to "queued" — must refuse rather than
 * strand that state behind a stub-minted id that nothing can resolve.
 */
export function emailApprovalBridgeReady(env: Env): boolean {
  void env;
  return false;
}

export async function queueEmailApproval(
  env: Env,
  request: EmailApprovalRequest,
): Promise<EmailApprovalResult> {
  // T7 replaces this body with the real PendingApproval insert; the
  // signature above is the contract T6 tools already call against.
  console.warn(
    `email_approval_not_wired ${JSON.stringify({
      kind: request.kind,
      mailbox: request.mailbox,
    })}`,
  );
  void env;
  return { approval_id: `apv-${randomHex(16)}` };
}
