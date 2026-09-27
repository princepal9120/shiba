/**
 * Cloudbox-style append-only evidence log. The receipt record and bounds
 * live in @shiba/shared (re-exported below); the secret-redacting write
 * helpers stay backend-only.
 */
import { MAX_RECEIPT_MESSAGE, MAX_RECEIPTS } from "@shiba/shared";
import type { Receipt, ReceiptKind } from "@shiba/shared";
import { boundTail, redactSecrets } from "./security.js";

export { MAX_RECEIPTS, MAX_RECEIPT_MESSAGE, RECEIPT_KINDS } from "@shiba/shared";
export type { Receipt, ReceiptKind } from "@shiba/shared";

export function makeReceipt(kind: ReceiptKind, message: string, at: number = Date.now()): Receipt {
  return {
    at,
    kind,
    message: boundTail(redactSecrets(message), MAX_RECEIPT_MESSAGE),
  };
}

export function appendReceipt(existing: Receipt[] | undefined, receipt: Receipt): Receipt[] {
  const next = [...(existing ?? []), receipt];
  if (next.length <= MAX_RECEIPTS) return next;
  return next.slice(next.length - MAX_RECEIPTS);
}

export function receiptsFromProgress(phase: string, message: string, at?: number): Receipt {
  const kind: ReceiptKind =
    phase === "clone" || phase === "configure" || phase === "code" || phase === "collect"
      ? phase
      : "code";
  return makeReceipt(kind, message, at);
}
