import { describe, expect, it, vi } from "vitest";
import { isPublicRequest } from "../src/public-routes.js";
import { handleWaitlist, parseWaitlistEntry } from "../src/waitlist.js";
import { Waitlist } from "../src/waitlist-do.js";

const ORIGIN = "https://tryshiba.dev";
const entry = { email: "  USER@example.com ", interest: "both", github: "@dev-user", consent: true };

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/waitlist`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("waitlist boundary", () => {
  it("only opens public site reads and waitlist POST, never app, admin or other APIs", () => {
    for (const path of ["/", "/why-shiba/", "/waitlist/", "/docs/overview/", "/assets/mascot/pet-logo.png"]) {
      expect(isPublicRequest(new Request(`${ORIGIN}${path}`))).toBe(true);
    }
    expect(isPublicRequest(post(entry))).toBe(true);
    for (const path of ["/app/", "/api/runs", "/api/admin/waitlist", "/api/waitlist/", "/agents/coding-orchestrator/default"]) {
      expect(isPublicRequest(new Request(`${ORIGIN}${path}`))).toBe(false);
    }
    expect(isPublicRequest(new Request(`${ORIGIN}/api/waitlist`, { method: "GET" }))).toBe(false);
    expect(isPublicRequest(new Request(`${ORIGIN}/waitlist/`, { method: "POST" }))).toBe(false);
  });

  it("normalizes valid input and rejects invalid consent, email, interest and GitHub handle", () => {
    expect(parseWaitlistEntry(entry)).toEqual({ email: "user@example.com", interest: "both", github: "dev-user" });
    expect(parseWaitlistEntry({ ...entry, consent: false })).toBeNull();
    expect(parseWaitlistEntry({ ...entry, email: "bad" })).toBeNull();
    expect(parseWaitlistEntry({ ...entry, email: "<script>@example.com" })).toBeNull();
    expect(parseWaitlistEntry({ ...entry, interest: "admin" })).toBeNull();
    expect(parseWaitlistEntry({ ...entry, github: "../bad" })).toBeNull();
  });

  it("forwards only validated data to storage and rejects cross-site or oversized submissions", async () => {
    const captured: Request[] = [];
    const env = { Waitlist: { idFromName: () => "id", get: () => ({ fetch: async (request: Request) => {
      captured.push(request);
      return Response.json({ ok: true }, { status: 201 });
    } }) } } as unknown as Parameters<typeof handleWaitlist>[1];
    expect((await handleWaitlist(post(entry), env))?.status).toBe(201);
    expect(captured).toHaveLength(1);
    expect(await captured[0]!.json()).toMatchObject({ email: "user@example.com", interest: "both", github: "dev-user" });
    expect((await handleWaitlist(post(entry, { Origin: "https://evil.example" }), env))?.status).toBe(403);
    expect((await handleWaitlist(post({ ...entry, email: "bad" }), env))?.status).toBe(400);
    expect((await handleWaitlist(post({ ...entry, company: "bot.example" }), env))?.status).toBe(400);
    expect((await handleWaitlist(post({ ...entry, padding: "x".repeat(5000) }), env))?.status).toBe(400);
    expect(captured).toHaveLength(1);
  });
});

class FakeSql {
  signups = new Map<string, { email: string; interest: string; github: string | null; created_at: number }>();
  rates = new Map<string, { count: number; expires_at: number }>();

  exec<T>(query: string, ...args: unknown[]): { toArray: () => T[] } {
    let rows: unknown[] = [];
    if (query.startsWith("SELECT email, interest")) rows = [...this.signups.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 1000);
    else if (query.startsWith("SELECT email FROM")) rows = this.signups.has(args[0] as string) ? [{ email: args[0] }] : [];
    else if (query.startsWith("DELETE FROM signups")) this.signups.delete(args[0] as string);
    else if (query.startsWith("DELETE FROM rate_limits")) {
      for (const [key, value] of this.rates) {
        if (query.includes("<= ?") ? value.expires_at <= (args[0] as number) : value.expires_at < (args[0] as number)) this.rates.delete(key);
      }
    } else if (query.startsWith("SELECT count FROM")) rows = this.rates.has(args[0] as string) ? [{ count: this.rates.get(args[0] as string)!.count }] : [];
    else if (query.startsWith("SELECT MIN(expires_at)")) rows = [{ next: this.rates.size ? Math.min(...[...this.rates.values()].map((v) => v.expires_at)) : null }];
    else if (query.startsWith("INSERT INTO rate_limits")) {
      const old = this.rates.get(args[0] as string);
      this.rates.set(args[0] as string, { count: (old?.count ?? 0) + 1, expires_at: args[1] as number });
    } else if (query.startsWith("INSERT INTO signups")) {
      const [email, interest, github, created_at] = args as [string, string, string | null, number];
      this.signups.set(email, { email, interest, github, created_at });
    }
    return { toArray: () => rows as T[] };
  }
}

describe("waitlist storage", () => {
  it("persists one row per email, supports private export/deletion and rate limits abuse", async () => {
    const sql = new FakeSql();
    const setAlarm = vi.fn();
    const object = new Waitlist({ storage: { sql, setAlarm } } as unknown as DurableObjectState);
    const payload = { email: "user@example.com", interest: "both", github: "dev-user", ipHash: "a".repeat(64) };
    const submit = (value: unknown) => object.fetch(new Request("https://internal/internal/waitlist", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    }));
    expect((await submit(payload)).status).toBe(201);
    expect((await submit(payload)).status).toBe(200);
    expect(sql.signups.size).toBe(1);
    expect((await (await object.fetch(new Request("https://internal/internal/waitlist"))).json() as { signups: unknown[] }).signups).toHaveLength(1);
    for (let i = 0; i < 3; i++) await submit({ ...payload, email: `user${i}@example.com` });
    expect((await submit({ ...payload, email: "over@example.com" })).status).toBe(429);
    expect(sql.signups.size).toBe(4);
    const deleted = await object.fetch(new Request("https://internal/internal/waitlist", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: payload.email }),
    }));
    expect(deleted.status).toBe(200);
    expect(sql.signups.has(payload.email)).toBe(false);
    expect(setAlarm).toHaveBeenCalled();
  });
});
