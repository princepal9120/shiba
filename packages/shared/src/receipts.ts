/**
 * Cloudbox-style append-only evidence log. A run is the receipts, not a
 * final envelope: init → clone/configure/code/collect → submit|error, plus
 * advisory grades. Bounded so DO state cannot grow without limit.
 */
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
