/**
 * Cloudbox-style append-only evidence log. A run is the receipts, not a
 * final envelope: init → clone/configure/code/collect → submit|error, plus
 * advisory grades. Bounded so DO state cannot grow without limit.
 */
import { boundTail, redactSecrets } from "./security.js";

export const MAX_RECEIPTS = 256;
export const MAX_RECEIPT_MESSAGE = 500;

export const RECEIPT_KINDS = [
  "init",
  "clone",
  "configure",
  "code",
  "collect",
  "submit",
  "grade",
  "triage",
  "error",
] as const;

export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export interface Receipt {
  at: number;
  kind: ReceiptKind;
  message: string;
}

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
