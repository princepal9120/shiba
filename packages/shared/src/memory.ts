/**
 * Memory-bank wire records — `GET /api/memory/*` serves these verbatim
 * (snake_case, epoch-millisecond timestamps).
 */

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
