/**
 * Memory MCP tools (megaplan task 9): the four-tool long-term-memory
 * surface registered on the gateway's {@link ToolRegistry}.
 *
 * Routing mirrors the Memory DO's instance model: facts live on per-agent
 * stubs (the instance IS the partition — `facts` rows carry no agent
 * column) and the reserved `global` stub owns `fact_registry` (fact id →
 * owning agent) plus the cross-agent `sessions` table.
 * - `memory_bank` writes on the caller's own stub: the tool takes no
 *   agent arg, so the verified token's principal is the owning agent —
 *   a `memory:write` principal can never bank into another agent's bank.
 *   The DO mints the fact id, claims it on the registry, and upserts the
 *   bge-base vector; all three roll back together on failure.
 * - `memory_recall` answers from `global`: it embeds the query, queries
 *   `MEMORY_VECTORS`, and joins each hit back to the owning agent's stub,
 *   so one call searches every agent's bankings. The tool projects each
 *   hit to the brief's join shape `{id, fact, source, agent, score}` and
 *   keeps the DO's score-descending order.
 * - `memory_forget` deletes through `global`: the registry resolves the
 *   owner, delegates the row delete, and drops its own index row — row,
 *   vector, and registry entry all go away.
 * - `memory_sessions` reads `global`'s sessions table, optionally
 *   `?agent=` scoped.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Scope } from "./agent-tokens.js";
import type { Env } from "./env.js";
import { memoryRegistryStub, memoryStub } from "./memory-do.js";
import type { FactRecord, SessionRecord } from "./memory-store.js";
import type { ToolRegistry } from "./mcp-gateway.js";
import { InputError } from "./security.js";

/** Matches the `ROUTE_PREFIX` convention the Memory DO uses for stub.fetch. */
const ROUTE_BASE = "https://internal/internal/memory";

/** Vectorize's documented `topK` ceiling — enforced by the DO too. */
const MAX_RECALL_LIMIT = 100;
const MAX_SESSIONS_LIMIT = 500;

const nonEmptyField = (field: string) =>
  z
    .string()
    .min(1, `${field} must be a non-empty string.`)
    .refine((v) => v.trim() !== "", `${field} must be a non-empty string.`);

// The DO rejects a non-positive or over-ceiling bound as a 400; the tool
// gate rejects it up front so a passing arg never trips the store's own
// validation (both surface as InputError either way).
const recallLimitField = z.number().int().min(1).max(MAX_RECALL_LIMIT).optional();
const sessionsLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_SESSIONS_LIMIT)
  .optional();
/** `ttl` is the store contract's epoch-milliseconds deadline, not a duration. */
const ttlField = z.number().nonnegative().optional();

// ---------------------------------------------------------------------------
// DO plumbing
// ---------------------------------------------------------------------------

/**
 * Read a JSON response off a `global`-stub call. A 4xx maps to
 * {@link InputError} (the caller's input named something absent/invalid);
 * anything else is a store fault.
 */
async function registryJson<T>(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  return stubJson<T>(memoryRegistryStub(env), path, init);
}

async function stubJson<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const res = await stub.fetch(new Request(`${ROUTE_BASE}${path}`, init));
  if (!res.ok) {
    let detail = `memory store returned ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") {
        detail = body.error;
      }
    } catch {
      // Non-JSON error body — keep the status line.
    }
    if (res.status === 404 || res.status === 400 || res.status === 409) {
      throw new InputError(detail);
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Response presenters
// ---------------------------------------------------------------------------

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** A fact hit joined through the registry carries its owning agent. */
interface RecalledFact {
  id: string;
  fact: string;
  source: string;
  agent: string;
  score: number;
}

/** The brief's recall join shape — exactly `{id, fact, source, agent, score}`. */
function recallView(hit: Record<string, unknown>): RecalledFact {
  return {
    id: String(hit.id),
    fact: String(hit.fact),
    source: String(hit.source),
    agent: String(hit.agent),
    score: Number(hit.score),
  };
}

// ---------------------------------------------------------------------------
// Arg parsing — the SDK validates these against the published JSON schema;
// handlers re-parse so direct `registry.invoke` callers get the same gate.
// ---------------------------------------------------------------------------

function parseArgs<S extends z.ZodType>(schema: S, args: Record<string, unknown>): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new InputError(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// registerMemoryTools
// ---------------------------------------------------------------------------

export function registerMemoryTools(registry: ToolRegistry, env: Env): void {
  const READ: Scope = "memory:read";
  const WRITE: Scope = "memory:write";

  const recallSchema = z.object({
    query: nonEmptyField("query"),
    limit: recallLimitField,
  });
  registry.registerTool(
    "memory_recall",
    READ,
    async (args) => {
      const { query, limit } = parseArgs(recallSchema, args);
      const params = new URLSearchParams({ q: query });
      if (limit !== undefined) params.set("limit", String(limit));
      const body = await registryJson<{ facts: Record<string, unknown>[] }>(
        env,
        `/facts/search?${params.toString()}`,
      );
      // The DO already sorts score-descending; sort again so the tool's
      // contract holds even if the route's order ever changes.
      const facts = (body?.facts ?? []).map(recallView).sort((a, b) => b.score - a.score);
      return jsonResult({ query, facts });
    },
    {
      description:
        "Semantic recall across every agent's banked facts (id/fact/source/agent/score, best first).",
      inputSchema: {
        query: nonEmptyField("query"),
        limit: recallLimitField,
      },
      annotations: { readOnlyHint: true },
    },
  );

  const bankSchema = z.object({
    fact: nonEmptyField("fact"),
    source: nonEmptyField("source"),
    ttl: ttlField,
  });
  registry.registerTool(
    "memory_bank",
    WRITE,
    async (args, ctx) => {
      const { fact, source, ttl } = parseArgs(bankSchema, args);
      // The owning agent is the verified principal — a caller cannot
      // bank into another agent's store by naming it.
      const body = await stubJson<{ fact: FactRecord & { agent: string } }>(
        memoryStub(env, ctx.principal.principal),
        "/facts",
        jsonPost({ fact, source, ...(ttl !== undefined ? { ttl } : {}) }),
      );
      return jsonResult({ fact: body?.fact ?? null });
    },
    {
      description:
        "Bank a durable fact under your own agent name (optional epoch-ms ttl expiry).",
      inputSchema: {
        fact: nonEmptyField("fact"),
        source: nonEmptyField("source"),
        ttl: ttlField,
      },
      annotations: { readOnlyHint: false },
    },
  );

  const forgetSchema = z.object({ fact_id: nonEmptyField("fact_id") });
  registry.registerTool(
    "memory_forget",
    WRITE,
    async (args) => {
      const { fact_id } = parseArgs(forgetSchema, args);
      const body = await registryJson<{ ok: boolean; id: string }>(
        env,
        `/facts/${encodeURIComponent(fact_id)}`,
        { method: "DELETE" },
      );
      return jsonResult({ ok: body?.ok === true, id: fact_id });
    },
    {
      description: "Forget a banked fact by id — drops the row, its vector, and the registry entry.",
      inputSchema: { fact_id: nonEmptyField("fact_id") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  );

  const sessionsSchema = z.object({
    agent: nonEmptyField("agent").optional(),
    limit: sessionsLimitField,
  });
  registry.registerTool(
    "memory_sessions",
    READ,
    async (args) => {
      const { agent, limit } = parseArgs(sessionsSchema, args);
      const params = new URLSearchParams();
      if (agent !== undefined) params.set("agent", agent);
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      const body = await registryJson<{ sessions: SessionRecord[] }>(
        env,
        `/sessions${qs === "" ? "" : `?${qs}`}`,
      );
      return jsonResult({ agent: agent ?? null, sessions: body?.sessions ?? [] });
    },
    {
      description: "List distilled run sessions, newest first (optionally one agent's).",
      inputSchema: {
        agent: nonEmptyField("agent").optional(),
        limit: sessionsLimitField,
      },
      annotations: { readOnlyHint: true },
    },
  );
}
