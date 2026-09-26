import type { DatabaseSync } from "node:sqlite";
import type { SqlRow } from "../../src/mailbox-store.js";

// Mirrors DO storage: raw BEGIN/COMMIT via sql.exec throws; transactionSync is the only way.
export function fakeSqlStorage(db: DatabaseSync) {
  return {
    sql: {
      exec: (sql: string, ...params: unknown[]) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) throw new Error("sql.exec cannot run transactions");
        return { toArray: () => db.prepare(sql).all(...(params as any[])) as SqlRow[] };
      },
    },
    transactionSync: <T>(fn: () => T): T => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
