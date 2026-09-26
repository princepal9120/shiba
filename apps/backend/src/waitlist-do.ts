import { parseWaitlistEntry } from "./waitlist.js";

const LIMIT_PER_HOUR = 5;

/** One SQLite-backed instance keeps the private launch/contributor list. */
export class Waitlist {
  constructor(private readonly ctx: DurableObjectState) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS signups (
        email TEXT PRIMARY KEY,
        interest TEXT NOT NULL,
        github TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/internal/waitlist") return new Response(null, { status: 404 });
    const sql = this.ctx.storage.sql;
    if (request.method === "GET") {
      const rows = sql.exec<{ email: string; interest: string; github: string | null; created_at: number }>(
        "SELECT email, interest, github, created_at FROM signups ORDER BY created_at DESC LIMIT 1000",
      ).toArray();
      return Response.json({ signups: rows });
    }
    if (request.method === "DELETE") {
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
      const email = typeof body === "object" && body !== null && "email" in body && typeof body.email === "string"
        ? body.email.trim().toLowerCase() : "";
      if (!email) return Response.json({ error: "Email required." }, { status: 400 });
      sql.exec("DELETE FROM signups WHERE email = ?", email);
      return Response.json({ ok: true });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
    const entry = parseWaitlistEntry({ ...(typeof body === "object" && body !== null ? body : {}), consent: true });
    const ipHash = typeof body === "object" && body !== null && "ipHash" in body ? body.ipHash : null;
    if (!entry || typeof ipHash !== "string" || !/^[a-f0-9]{64}$/.test(ipHash)) {
      return Response.json({ error: "Invalid signup." }, { status: 400 });
    }
    const now = Date.now();
    const bucket = `${ipHash}:${Math.floor(now / 3_600_000)}`;
    sql.exec("DELETE FROM rate_limits WHERE expires_at < ?", now);
    const used = sql.exec<{ count: number }>("SELECT count FROM rate_limits WHERE bucket = ?", bucket).toArray()[0]?.count ?? 0;
    if (used >= LIMIT_PER_HOUR) return Response.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    await this.ctx.storage.setAlarm((Math.floor(now / 3_600_000) + 1) * 3_600_000 + 1_000);
    sql.exec(
      "INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1",
      bucket, (Math.floor(now / 3_600_000) + 1) * 3_600_000,
    );
    const existing = sql.exec<{ email: string }>("SELECT email FROM signups WHERE email = ?", entry.email).toArray().length > 0;
    if (!existing) {
      sql.exec(
        "INSERT INTO signups (email, interest, github, created_at) VALUES (?, ?, ?, ?)",
        entry.email, entry.interest, entry.github, now,
      );
    }
    return Response.json({ ok: true, alreadyJoined: existing }, { status: existing ? 200 : 201 });
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM rate_limits WHERE expires_at <= ?", Date.now());
    const next = sql.exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM rate_limits").toArray()[0]?.next;
    if (next != null) await this.ctx.storage.setAlarm(next + 1_000);
  }
}
