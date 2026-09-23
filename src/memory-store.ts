/**
 * Memory store (megaplan task 8): pure SQL layer behind `MemoryDO`.
 *
 * Same contract as {@link MailboxStore} — constructed over an injected
 * {@link SqlExec} so the code runs on `ctx.storage.sql` inside the Durable
 * Object and under Vitest on `node:sqlite`. One statement per call, `?`
 * positional params.
 *
 * Instance model: per-agent stubs (`idFromName(agent)`) own that agent's
 * `facts` rows — the table has no `agent` column because the DO instance IS
 * the partition. The reserved global stub holds `fact_registry`, one row
 * mapping each fact id to the agent that banked it (the index cross-agent
 * recall joins through), and `sessions`, the cross-agent run log — session
 * rows already carry their `agent` column, so the global table answers
 * `GET /sessions` (optionally `?agent=`) with a single local query.
 */
import { InputError } from "./security.js";

// ---------------------------------------------------------------------------
// SQL surface
// ---------------------------------------------------------------------------

export type SqlScalar = string | number | null;
export type SqlRow = Record<string, SqlScalar>;
export type SqlExec = (sql: string, ...params: SqlScalar[]) => SqlRow[];

/**
 * DDL executed statement-by-statement by {@link MemoryStore.init}. Applied to
 * every Memory DO instance — per-agent stubs leave `fact_registry`/`sessions`
 * unused, the global stub leaves `facts` unused; shared schema keeps the DO
 * bootstrap identical across instances.
 */
export const MEMORY_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS facts (
     id TEXT PRIMARY KEY,
     fact TEXT NOT NULL,
     source TEXT NOT NULL,
     embedding_id TEXT,
     created_at INTEGER NOT NULL,
     ttl INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS facts_created ON facts(created_at)`,
  `CREATE INDEX IF NOT EXISTS facts_ttl ON facts(ttl)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     agent TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     summary TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent)`,
  `CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at)`,
  // Global-stub index: every banked fact id → the agent stub that owns it.
  // Cross-agent recall hits fact ids from Vectorize and joins through this.
  `CREATE TABLE IF NOT EXISTS fact_registry (
     fact_id TEXT PRIMARY KEY,
     agent TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS fact_registry_agent ON fact_registry(agent)`,
];

/**
 * Spec-facing schema bundle — NOT a single exec'able statement. Apply with
 * {@link MemoryStore.init} or by iterating `.statements`; `.ddl` is the same
 * schema rendered as text for docs/spec checks.
 */
export const MEMORY_SCHEMA = {
  statements: MEMORY_STATEMENTS,
  ddl: `${MEMORY_STATEMENTS.join(";\n\n")};\n`,
} as const;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface FactRecord {
  id: string;
  fact: string;
  /** Provenance tag — run / email / manual (free-form, rendered as a badge). */
  source: string;
  /** Vectorize vector id (same as `id` once the embedding lands), or null. */
  embedding_id: string | null;
  /** Epoch milliseconds. */
  created_at: number;
  /** Epoch-milliseconds expiry; null = durable. Purged lazily on read. */
  ttl: number | null;
}

export interface SessionRecord {
  id: string;
  agent: string;
  /** Epoch milliseconds. */
  started_at: number;
  summary: string;
}

/** One global-registry row — the fact id → owning agent mapping. */
export interface FactRegistryEntry {
  fact_id: string;
  agent: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface BankFactInput {
  id?: string;
  fact: string;
  source: string;
  /** Epoch-milliseconds expiry; omitted = durable. */
  ttl?: number | null;
  /** Vectorize id assigned by the caller (the fact id by convention). */
  embedding_id?: string | null;
  nowMs?: number;
}

export interface AddSessionInput {
  id?: string;
  agent: string;
  /** Epoch milliseconds; defaults to now. */
  started_at?: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(raw)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function newId(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

function clampLimit(limit: number | undefined): number {
  // Non-finite values (NaN from an unchecked tool arg, ±Infinity) cannot
  // bind into `LIMIT ?` — SQLite rejects them as a datatype mismatch.
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  // 0 is a real bound (empty page), not "unset" — clamp to [0, MAX].
  return Math.max(0, Math.min(MAX_LIST_LIMIT, Math.floor(limit)));
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new InputError(`${field} must be a non-empty string.`);
  }
  return trimmed;
}

function rowToFact(row: SqlRow): FactRecord {
  return {
    id: String(row.id),
    fact: String(row.fact),
    source: String(row.source),
    embedding_id: row.embedding_id === null ? null : String(row.embedding_id),
    created_at: Number(row.created_at),
    ttl: row.ttl === null ? null : Number(row.ttl),
  };
}

function rowToSession(row: SqlRow): SessionRecord {
  return {
    id: String(row.id),
    agent: String(row.agent),
    started_at: Number(row.started_at),
    summary: String(row.summary),
  };
}

function rowToRegistryEntry(row: SqlRow): FactRegistryEntry {
  return {
    fact_id: String(row.fact_id),
    agent: String(row.agent),
    created_at: Number(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  constructor(private readonly exec: SqlExec) {}

  /** Idempotent — every statement is IF NOT EXISTS. */
  init(): void {
    for (const statement of MEMORY_STATEMENTS) {
      this.exec(statement);
    }
  }

  // -- facts (per-agent stub) ------------------------------------------------

  /**
   * Insert a fact row. `ttl` is the epoch-milliseconds expiry deadline —
   * omit for a durable fact. Vectorize upsert is the caller's job (the DO
   * owns the async boundary); the returned row's `embedding_id` records
   * which vector id the caller stored it under.
   */
  bankFact(input: BankFactInput): FactRecord {
    const fact = requireNonEmpty(input.fact, "fact");
    const source = requireNonEmpty(input.source, "source");
    if (input.ttl !== undefined && input.ttl !== null) {
      if (!Number.isFinite(input.ttl)) {
        throw new InputError("ttl must be a finite epoch-milliseconds deadline.");
      }
      if (input.ttl < 0) {
        throw new InputError("ttl must not be negative.");
      }
    }
    const id = input.id ?? newId("fact");
    const created = input.nowMs ?? Date.now();
    this.exec(
      `INSERT INTO facts (id, fact, source, embedding_id, created_at, ttl)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      fact,
      source,
      input.embedding_id ?? null,
      created,
      input.ttl ?? null,
    );
    const row = this.exec(`SELECT * FROM facts WHERE id = ?`, id)[0];
    if (!row) {
      throw new Error("bankFact insert did not produce a row");
    }
    return rowToFact(row);
  }

  /**
   * Delete fact rows whose `ttl` deadline has passed. Runs lazily inside
   * every read — there is no sweeper, so "purge on read" is the only GC.
   * Returns the purged ids so the DO can drop their vectors too.
   */
  purgeExpiredFacts(nowMs?: number): string[] {
    return this.exec(
      `DELETE FROM facts WHERE ttl IS NOT NULL AND ttl <= ? RETURNING id`,
      nowMs ?? Date.now(),
    ).map((row) => String(row.id));
  }

  /** Live fact by id — an expired row is purged and reads as absent. */
  getFact(id: string, nowMs?: number): FactRecord | null {
    this.purgeExpiredFacts(nowMs);
    const row = this.exec(`SELECT * FROM facts WHERE id = ?`, id)[0];
    return row ? rowToFact(row) : null;
  }

  /**
   * Live facts, newest first — expired rows are purged before listing.
   * Agent scoping is the DO instance (per-agent partition), not a filter
   * param here — the spec's `listFacts(agent?, …)` maps to `?agent=` on
   * the registry routes, which merge per-agent stub listings.
   */
  listFacts(filter: { limit?: number; nowMs?: number } = {}): FactRecord[] {
    this.purgeExpiredFacts(filter.nowMs);
    return this.exec(
      `SELECT * FROM facts ORDER BY created_at DESC LIMIT ?`,
      clampLimit(filter.limit),
    ).map(rowToFact);
  }

  /** Hard delete — returns whether a row was removed. */
  forgetFact(id: string): boolean {
    const rows = this.exec(`DELETE FROM facts WHERE id = ? RETURNING id`, id);
    return rows.length > 0;
  }

  // -- sessions (global stub) ------------------------------------------------

  addSession(input: AddSessionInput): SessionRecord {
    const agent = requireNonEmpty(input.agent, "agent");
    const summary = requireNonEmpty(input.summary, "summary");
    const id = input.id ?? newId("sess");
    const started = input.started_at ?? Date.now();
    this.exec(
      `INSERT INTO sessions (id, agent, started_at, summary)
       VALUES (?, ?, ?, ?)`,
      id,
      agent,
      started,
      summary,
    );
    const row = this.exec(`SELECT * FROM sessions WHERE id = ?`, id)[0];
    if (!row) {
      throw new Error("addSession insert did not produce a row");
    }
    return rowToSession(row);
  }

  /** Session by id, or null when absent — the duplicate-id pre-check. */
  getSession(id: string): SessionRecord | null {
    const row = this.exec(`SELECT * FROM sessions WHERE id = ?`, id)[0];
    return row ? rowToSession(row) : null;
  }

  /** Sessions, newest first; `agent` narrows to one agent's log. */
  listSessions(filter: { agent?: string; limit?: number } = {}): SessionRecord[] {
    const limit = clampLimit(filter.limit);
    const agent = filter.agent?.trim();
    if (agent) {
      return this.exec(
        `SELECT * FROM sessions WHERE agent = ? ORDER BY started_at DESC LIMIT ?`,
        agent,
        limit,
      ).map(rowToSession);
    }
    return this.exec(
      `SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`,
      limit,
    ).map(rowToSession);
  }

  // -- fact registry (global stub) -------------------------------------------

  /**
   * Index one fact id → owning agent. Upserting is deliberate: a replayed
   * bank (at-least-once delivery) rewrites the same row instead of erroring.
   */
  registerFact(input: { fact_id: string; agent: string; nowMs?: number }): FactRegistryEntry {
    const factId = requireNonEmpty(input.fact_id, "fact_id");
    const agent = requireNonEmpty(input.agent, "agent");
    this.exec(
      `INSERT INTO fact_registry (fact_id, agent, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(fact_id) DO UPDATE SET agent = excluded.agent`,
      factId,
      agent,
      input.nowMs ?? Date.now(),
    );
    const row = this.exec(`SELECT * FROM fact_registry WHERE fact_id = ?`, factId)[0];
    if (!row) {
      throw new Error("registerFact upsert did not produce a row");
    }
    return rowToRegistryEntry(row);
  }

  /** Owning agent for a fact id, or null when unregistered. */
  factOwner(factId: string): string | null {
    const row = this.exec(
      `SELECT agent FROM fact_registry WHERE fact_id = ?`,
      factId,
    )[0];
    return row ? String(row.agent) : null;
  }

  /** Agents that have banked ≥1 fact — the recall/list fan-out set. */
  listRegisteredAgents(): string[] {
    return this.exec(`SELECT DISTINCT agent FROM fact_registry ORDER BY agent`).map((row) =>
      String(row.agent),
    );
  }

  /** Drop a registry row on forget — returns whether a row was removed. */
  unregisterFact(factId: string): boolean {
    const rows = this.exec(
      `DELETE FROM fact_registry WHERE fact_id = ? RETURNING fact_id`,
      factId,
    );
    return rows.length > 0;
  }
}
