import { describe, expect, it, vi } from "vitest";
import { AUDIT_STATEMENTS, audit, initAudit, type AuditEnv } from "../src/audit.js";

/**
 * Pure-boundary harness: the writer's only seam is `env.AGENT_AUDIT`, faked
 * by an in-memory D1 that records (sql, params) pairs the way D1 hands them
 * to SQLite — `.prepare()` → `.bind(...)` → `.run()`.
 */
interface D1Call {
  sql: string;
  params: unknown[];
}

class FakeD1 {
  readonly calls: D1Call[] = [];
  fail = false;

  prepare(sql: string) {
    const calls = this.calls;
    const shouldFail = () => this.fail;
    const run = async (...params: unknown[]) => {
      if (shouldFail()) {
        throw new Error("d1 unavailable");
      }
      calls.push({ sql, params });
      return { success: true, results: [], meta: {} };
    };
    return {
      run: () => run(),
      bind: (...params: unknown[]) => ({
        run: () => run(...params),
        all: async () => ({ results: [], success: true, meta: {} }),
        first: async () => null,
      }),
    };
  }
}

function makeEnv(): AuditEnv & { d1: FakeD1 } {
  const d1 = new FakeD1();
  return { AGENT_AUDIT: d1 as unknown as D1Database, d1 };
}

const ENTRY = {
  principal: "scout",
  tool: "search_emails",
  argsHash: "a".repeat(64),
  outcome: "ok",
} as const;

describe("initAudit", () => {
  it("executes every AUDIT_STATEMENTS DDL statement", async () => {
    const env = makeEnv();
    await initAudit(env);
    expect(env.d1.calls).toHaveLength(AUDIT_STATEMENTS.length);
    expect(env.d1.calls.map((c) => c.sql)).toEqual([...AUDIT_STATEMENTS]);
    expect(AUDIT_STATEMENTS[0]).toContain("CREATE TABLE IF NOT EXISTS audit_log");
    // Idempotent by contract — a second run must not fail.
    await initAudit(env);
  });
});

describe("audit", () => {
  it("inserts one audit_log row with hashed args, never the args", async () => {
    const env = makeEnv();
    await audit(env, { ...ENTRY, ts: 1_234, detail: "denied: missing scope" });
    const insert = env.d1.calls.find((c) => c.sql.startsWith("INSERT INTO audit_log"));
    expect(insert).toBeDefined();
    const [id, ts, principal, tool, argsHash, outcome, detail] = insert!.params;
    expect(id).toMatch(/^aud-[0-9a-f]{16}$/);
    expect(ts).toBe(1_234);
    expect(principal).toBe("scout");
    expect(tool).toBe("search_emails");
    expect(argsHash).toBe("a".repeat(64));
    expect(outcome).toBe("ok");
    expect(detail).toBe("denied: missing scope");
  });

  it("defaults ts to now and detail to null", async () => {
    const env = makeEnv();
    const before = Date.now();
    await audit(env, ENTRY);
    const insert = env.d1.calls.find((c) => c.sql.startsWith("INSERT INTO audit_log"))!;
    expect(Number(insert.params[1])).toBeGreaterThanOrEqual(before);
    expect(insert.params[6]).toBeNull();
  });

  it("self-heals a missing table once, then writes directly", async () => {
    const env = makeEnv();
    await audit(env, ENTRY);
    await audit(env, ENTRY);
    // First call ran the DDL batch + one insert; the second inserts alone —
    // the WeakSet memo means steady-state cost is a single round-trip.
    const ddl = env.d1.calls.filter((c) => c.sql.startsWith("CREATE"));
    const inserts = env.d1.calls.filter((c) => c.sql.startsWith("INSERT"));
    expect(ddl).toHaveLength(AUDIT_STATEMENTS.length);
    expect(inserts).toHaveLength(2);
  });

  it("is fire-and-forget safe: D1 failure warns and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = makeEnv();
    env.d1.fail = true;
    await expect(audit(env, ENTRY)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("audit write failed");
    warn.mockRestore();
  });

  it("retries init on the next call after an init failure", async () => {
    const env = makeEnv();
    env.d1.fail = true;
    await audit(env, ENTRY);
    env.d1.fail = false;
    // Nothing was written while D1 was down — no half-committed schema.
    expect(env.d1.calls).toHaveLength(0);
    await audit(env, ENTRY);
    expect(env.d1.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(true);
  });
});
