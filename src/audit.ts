/**
 * Audit writer (megaplan task 4): one `audit_log` row per MCP tool call, in
 * the `AGENT_AUDIT` D1 database.
 *
 * `args_hash` holds a SHA-256 of the canonical JSON args — never the args
 * themselves: an audit reader learns that a call happened and can compare
 * two calls for equality, but cannot read what a draft or query contained.
 *
 * The write path is fire-and-forget safe — {@link audit} swallows every
 * failure into `console.warn`, so a D1 outage can never break the tool call
 * it records. A missing table self-heals: the first write per isolate runs
 * {@link initAudit} (idempotent DDL) before inserting.
 */
import { randomHex } from "./mailbox-store.js";
import { redactSecrets } from "./security.js";

/** Narrow env surface — the D1 binding wired in wrangler.jsonc. */
export interface AuditEnv {
  AGENT_AUDIT: D1Database;
}

/**
 * Idempotent schema — apply statement-by-statement via {@link initAudit}.
 * `ts`/`principal` indexes serve the T13 `GET /api/audit` newest-first and
 * per-principal reads.
 */
export const AUDIT_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY,
     ts INTEGER NOT NULL,
     principal TEXT NOT NULL,
     tool TEXT NOT NULL,
     args_hash TEXT NOT NULL,
     outcome TEXT NOT NULL,
     detail TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts)`,
  `CREATE INDEX IF NOT EXISTS audit_log_principal_ts ON audit_log(principal, ts)`,
];

export interface AuditEntry {
  principal: string;
  tool: string;
  /**
   * SHA-256 hex of the canonical (sorted-key JSON) tool args — a hash,
   * never the args. The gateway computes it; this store only records it.
   */
  argsHash: string;
  /** Conventional values: "ok", "error", "denied". */
  outcome: string;
  /** Optional free-text context (error class, denial reason). */
  detail?: string;
  /** Epoch milliseconds — defaults to Date.now(); tests pin it. */
  ts?: number;
}

/** Create `audit_log` and its indexes if missing. Idempotent. */
export async function initAudit(env: AuditEnv): Promise<void> {
  for (const statement of AUDIT_STATEMENTS) {
    await env.AGENT_AUDIT.prepare(statement).run();
  }
}

/**
 * Bindings already initialized in this isolate. D1 objects are scoped to
 * the binding, so the WeakSet keys on the database, not the env — a second
 * write per isolate costs one round-trip instead of re-running the DDL.
 */
const initialized = new WeakSet<D1Database>();

/** Run the idempotent DDL once per isolate per binding. */
async function ensureAuditTable(env: AuditEnv): Promise<void> {
  if (!initialized.has(env.AGENT_AUDIT)) {
    await initAudit(env);
    initialized.add(env.AGENT_AUDIT);
  }
}

/**
 * Insert one audit row. Never throws: init or insert failures log a
 * (secret-redacted) warning and resolve — audit is observability, not a
 * gate on the tool call it records.
 */
export async function audit(env: AuditEnv, entry: AuditEntry): Promise<void> {
  try {
    await ensureAuditTable(env);
    await env.AGENT_AUDIT.prepare(
      `INSERT INTO audit_log (id, ts, principal, tool, args_hash, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `aud-${randomHex(16)}`,
        entry.ts ?? Date.now(),
        entry.principal,
        entry.tool,
        entry.argsHash,
        entry.outcome,
        entry.detail ?? null,
      )
      .run();
  } catch (error: unknown) {
    console.warn(
      `audit write failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

/** Row shape the dashboard's `GET /api/audit` returns — one per MCP call. */
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

/**
 * Read audit rows newest-first for `GET /api/audit`. `principal` narrows to
 * one agent; `limit` is already clamped by the caller (the route caps at
 * 200). Throws on failure — unlike the write path this is a user-facing
 * query, so a D1 outage must surface as an error, not a fake empty log.
 */
export async function listAuditEntries(
  env: AuditEnv,
  options: { limit: number; principal?: string },
): Promise<AuditRow[]> {
  await ensureAuditTable(env);
  const principal = options.principal?.trim();
  const statement = principal
    ? `SELECT id, ts, principal, tool, args_hash, outcome, detail
       FROM audit_log WHERE principal = ? ORDER BY ts DESC LIMIT ?`
    : `SELECT id, ts, principal, tool, args_hash, outcome, detail
       FROM audit_log ORDER BY ts DESC LIMIT ?`;
  const prepared = env.AGENT_AUDIT.prepare(statement);
  const { results } = await (principal
    ? prepared.bind(principal, options.limit)
    : prepared.bind(options.limit)
  ).all<AuditRow>();
  return results ?? [];
}

/** Retention window: the audit log is observability, not history — 90 days. */
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Delete audit rows older than `cutoffTs` (epoch ms); the cron `scheduled`
 * handler passes `Date.now() - AUDIT_RETENTION_MS`. Returns the deleted
 * count when D1 reports it. Throws — the caller logs and the next tick
 * retries, so a D1 hiccup never compounds.
 */
export async function pruneAuditLog(env: AuditEnv, cutoffTs: number): Promise<number> {
  await ensureAuditTable(env);
  const result = await env.AGENT_AUDIT.prepare(`DELETE FROM audit_log WHERE ts < ?`)
    .bind(cutoffTs)
    .run();
  return typeof result.meta.changes === "number" ? result.meta.changes : 0;
}
