/**
 * Audit-log wire row served by `GET /api/audit` — one row per MCP tool
 * call. `args_hash` is a SHA-256 fingerprint of the args, never the args
 * themselves, so a table can show it verbatim. `ts` is epoch ms.
 */
export interface AuditRow {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  principal: string;
  tool: string;
  /** SHA-256 fingerprint of the args — never the args themselves. */
  args_hash: string;
  outcome: string;
  detail: string | null;
}
