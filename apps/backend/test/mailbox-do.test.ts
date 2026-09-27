import { DatabaseSync } from "node:sqlite";
import { fakeSqlStorage } from "./fixtures/do-sql-storage.js";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  Mailbox,
  MAILBOX_DIRECTORY_NAME,
  mailboxDirectoryStub,
  mailboxStub,
} from "../src/mailbox-do.js";

/**
 * Route-level tests: the DO's only hard dependency is `ctx.storage.sql`,
 * faked here over `node:sqlite` — `exec(...).toArray()` mirrors the workerd
 * cursor shape the production adapter consumes. `env.Mailbox` is a stub map
 * keyed by `idFromName` input so the directory delegation inside
 * `GET /mailbox` runs for real (each fake stub lazily creates its own DO
 * with its own SQLite database, preserving per-address isolation).
 */

interface FakeStub {
  fetch: (request: Request) => Promise<Response>;
}

interface Harness {
  stub: (address: string) => FakeStub;
  directory: FakeStub;
  /** In-memory ATTACHMENTS bucket — the DO deletes keys on hard delete. */
  r2: Map<string, Uint8Array>;
}

function makeHarness(): Harness {
  const stubs = new Map<string, FakeStub>();
  const r2 = new Map<string, Uint8Array>();
  const create = (name: string): FakeStub => {
    const db = new DatabaseSync(":memory:");
    const ctx = {
      id: {
        name,
        toString: () => `id:${name}`,
        equals: () => false,
      },
      storage: fakeSqlStorage(db),
      blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
      waitUntil: () => {},
    };
    const obj = new Mailbox(ctx as unknown as DurableObjectState, env);
    return { fetch: (request: Request) => obj.fetch(request) };
  };
  const env = {
    Mailbox: {
      idFromName: (name: string) => ({
        name,
        toString: () => `id:${name}`,
        equals: () => false,
      }),
      get: (id: { name?: string }) => {
        const name = id.name ?? "";
        let stub = stubs.get(name);
        if (!stub) {
          stub = create(name);
          stubs.set(name, stub);
        }
        return stub;
      },
    },
    ATTACHMENTS: {
      put: async (key: string, value: Uint8Array) => {
        r2.set(key, value);
      },
      get: async (key: string) => r2.get(key) ?? null,
      delete: async (key: string) => {
        r2.delete(key);
      },
    },
  } as unknown as Env;
  return {
    // Go through the real helpers so stub-name normalization is exercised.
    stub: (address) => mailboxStub(env, address) as unknown as FakeStub,
    directory: mailboxDirectoryStub(env) as unknown as FakeStub,
    r2,
  };
}

const BASE = "https://internal/internal/mailbox";

function get(stub: FakeStub, path: string): Promise<Response> {
  return stub.fetch(new Request(`${BASE}${path}`));
}

function send(stub: FakeStub, method: string, path: string, body?: unknown): Promise<Response> {
  return stub.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function asJson(res: Response): Promise<any> {
  return res.json();
}

function seedEmail(stub: FakeStub, over: Record<string, unknown> = {}) {
  return send(stub, "POST", "/emails", {
    direction: "inbound",
    from_addr: "sender@example.com",
    to_addr: "agent@shiba.dev",
    subject: "Deploy report",
    body_text: "the deploy finished at noon",
    ...over,
  });
}

describe("stub helpers", () => {
  it("mailboxStub resolves per address; directory resolves the reserved name", () => {
    const env = {
      Mailbox: {
        idFromName: (name: string) => ({ name }),
        get: (id: { name?: string }) => ({ name: id.name }),
      },
    } as unknown as Env;
    expect((mailboxStub(env, "agent@shiba.dev") as unknown as { name: string }).name).toBe(
      "agent@shiba.dev",
    );
    // Case/whitespace variants of one address must resolve to one stub.
    expect((mailboxStub(env, " Agent@Shiba.dev ") as unknown as { name: string }).name).toBe(
      "agent@shiba.dev",
    );
    expect((mailboxDirectoryStub(env) as unknown as { name: string }).name).toBe(
      MAILBOX_DIRECTORY_NAME,
    );
  });
});

describe("mailbox registry (directory stub)", () => {
  it("rejects invalid cloud-agent assignments through the HTTP registry route", async () => {
    const h = makeHarness();
    expect((await send(h.directory, "POST", "/mailboxes", {
      address: "agent@shiba.dev", agent: "two words",
    })).status).toBe(400);
    expect((await asJson(await get(h.directory, "/mailboxes"))).mailboxes).toEqual([]);
  });

  it("registers, lists, and answers isRegistered", async () => {
    const h = makeHarness();
    const created = await send(h.directory, "POST", "/mailboxes", {
      address: "Agent@Shiba.dev",
      label: "Agent",
      agent: "intern",
    });
    expect(created.status).toBe(201);
    expect((await asJson(created)).mailbox).toMatchObject({
      address: "agent@shiba.dev",
      label: "Agent",
      agent: "intern",
    });

    const list = await asJson(await get(h.directory, "/mailboxes"));
    expect(list.mailboxes).toHaveLength(1);

    const hit = await asJson(await get(h.directory, "/mailboxes/agent@shiba.dev"));
    expect(hit.registered).toBe(true);
    expect(hit.mailbox?.address).toBe("agent@shiba.dev");

    const miss = await asJson(await get(h.directory, "/mailboxes/nobody@shiba.dev"));
    expect(miss.registered).toBe(false);
    expect(miss.mailbox).toBeNull();
  });

  it("rejects registry routes on non-directory stubs", async () => {
    const h = makeHarness();
    const address = h.stub("agent@shiba.dev");
    expect((await send(address, "POST", "/mailboxes", { address: "x@y.z" })).status).toBe(400);
    expect((await get(address, "/mailboxes")).status).toBe(400);
    expect((await get(address, "/mailboxes/agent@shiba.dev")).status).toBe(400);
  });

  it("rejects mail writes on the directory stub", async () => {
    const h = makeHarness();
    expect((await seedEmail(h.directory)).status).toBe(400);
    expect(
      (
        await send(h.directory, "POST", "/drafts", {
          to_addr: "x@y.z",
          subject: "s",
          body_text: "b",
        })
      ).status,
    ).toBe(400);
    expect((await send(h.directory, "DELETE", "/emails/eml-x")).status).toBe(400);
    expect((await send(h.directory, "POST", "/emails/eml-x/read")).status).toBe(400);
    expect((await send(h.directory, "PATCH", "/drafts/drf-x", {})).status).toBe(400);
    // Reads still answer (empty) — only writes are refused.
    expect((await asJson(await get(h.directory, "/emails"))).emails).toHaveLength(0);
  });

  it("validates the address", async () => {
    const h = makeHarness();
    expect(
      (await send(h.directory, "POST", "/mailboxes", { address: "not-an-address" })).status,
    ).toBe(400);
    expect((await send(h.directory, "POST", "/mailboxes", {})).status).toBe(400);
  });
});

describe("email routes", () => {
  it("adds, reads, lists, and filters emails", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    const created = await seedEmail(stub);
    expect(created.status).toBe(201);
    const { email } = await asJson(created);
    expect(email.status).toBe("unread");

    const one = await asJson(await get(stub, `/emails/${email.id}`));
    expect(one.email.subject).toBe("Deploy report");
    expect((await get(stub, "/emails/eml-nope")).status).toBe(404);

    const all = await asJson(await get(stub, "/emails"));
    expect(all.emails).toHaveLength(1);
    expect((await asJson(await get(stub, "/emails?status=unread"))).emails).toHaveLength(1);
    expect((await asJson(await get(stub, "/emails?status=read"))).emails).toHaveLength(0);
    expect(
      (await asJson(await get(stub, "/emails?mailbox=agent@shiba.dev"))).emails,
    ).toHaveLength(1);
    expect((await asJson(await get(stub, "/emails?mailbox=other@x.dev"))).emails).toHaveLength(0);
    expect((await get(stub, "/emails?status=bogus")).status).toBe(400);
  });

  it("searches emails with the store's sanitized FTS", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    await seedEmail(stub);
    await seedEmail(stub, { subject: "Invoice overdue", body_text: "please pay" });
    expect((await asJson(await get(stub, "/emails/search?q=deploy"))).emails).toHaveLength(1);
    expect((await asJson(await get(stub, "/emails/search?q=invoice"))).emails).toHaveLength(1);
    expect(
      (await asJson(await get(stub, "/emails/search?q=deploy&mailbox=other@x.dev"))).emails,
    ).toHaveLength(0);
    expect((await asJson(await get(stub, "/emails/search"))).emails).toHaveLength(0);
  });

  it("reads threads, marks read idempotently, moves status, deletes", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    const { email } = await asJson(await seedEmail(stub));

    const thread = await asJson(await get(stub, `/threads/${email.thread_id}`));
    expect(thread.thread.emails).toHaveLength(1);
    expect((await get(stub, "/threads/thr-nope")).status).toBe(404);

    const read = await asJson(await send(stub, "POST", `/emails/${email.id}/read`));
    expect(read.email.status).toBe("read");
    expect(read.changed).toBe(true);
    const reread = await asJson(await send(stub, "POST", `/emails/${email.id}/read`));
    expect(reread.changed).toBe(false);
    expect((await send(stub, "POST", "/emails/eml-nope/read")).status).toBe(404);

    const moved = await asJson(await send(stub, "POST", `/emails/${email.id}/move`, {
      status: "archived",
    }));
    expect(moved.email.status).toBe("archived");
    expect(
      (await send(stub, "POST", `/emails/${email.id}/move`, { status: "bogus" })).status,
    ).toBe(400);
    expect(
      (await send(stub, "POST", "/emails/eml-nope/move", { status: "read" })).status,
    ).toBe(404);

    expect((await send(stub, "DELETE", `/emails/${email.id}`)).status).toBe(200);
    expect((await send(stub, "DELETE", `/emails/${email.id}`)).status).toBe(404);
  });

  it("hard delete removes the email's R2 objects enumerated by the manifest", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    // The handler writes bodies to R2 before the store call commits their
    // manifest rows — seed the bucket with objects under the same keys.
    const { email } = await asJson(
      await seedEmail(stub, {
        id: "eml-cleanup",
        attachments: [
          {
            part_id: "part-0",
            filename: "a.csv",
            mime_type: "text/csv",
            size: 1,
            r2_key: "eml-cleanup/part-0",
          },
          { part_id: "raw-source", mime_type: "message/rfc822", size: 2, r2_key: "eml-cleanup/raw-source" },
        ],
      }),
    );
    h.r2.set("eml-cleanup/part-0", new Uint8Array([1]));
    h.r2.set("eml-cleanup/raw-source", new Uint8Array([2, 3]));
    // Another email's body is untouched.
    h.r2.set("eml-other/part-0", new Uint8Array([9]));

    expect((await send(stub, "DELETE", `/emails/${email.id}`)).status).toBe(200);
    expect(h.r2.has("eml-cleanup/part-0")).toBe(false);
    expect(h.r2.has("eml-cleanup/raw-source")).toBe(false);
    expect(h.r2.has("eml-other/part-0")).toBe(true);
    expect((await get(stub, `/emails/${email.id}`)).status).toBe(404);
  });

  it("keeps each address's mail isolated to its own stub", async () => {
    const h = makeHarness();
    const a = h.stub("agent@shiba.dev");
    const b = h.stub("other@shiba.dev");
    await seedEmail(a);
    expect((await asJson(await get(a, "/emails"))).emails).toHaveLength(1);
    expect((await asJson(await get(b, "/emails"))).emails).toHaveLength(0);
  });

  it("routes every case/whitespace spelling of an address to one stub", async () => {
    const h = makeHarness();
    await seedEmail(h.stub("Agent@Shiba.dev"));
    const listed = await asJson(await get(h.stub(" agent@shiba.dev "), "/emails"));
    expect(listed.emails).toHaveLength(1);
  });

  it("rejects a duplicate caller-supplied id as a 400, not a 500", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    const { email } = await asJson(await seedEmail(stub));
    const dup = await seedEmail(stub, { id: email.id, subject: "retry" });
    expect(dup.status).toBe(400);
    expect((await asJson(dup)).error).toContain("already exists");
    // The failed insert left nothing behind.
    expect((await asJson(await get(stub, "/emails"))).emails).toHaveLength(1);
  });
});

describe("draft routes", () => {
  it("creates, updates, and lists drafts", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    const { email } = await asJson(await seedEmail(stub));
    const created = await send(stub, "POST", "/drafts", {
      to_addr: "sender@example.com",
      subject: "Re: Deploy report",
      body_text: "thanks",
      thread_id: email.thread_id,
    });
    expect(created.status).toBe(201);
    const { draft } = await asJson(created);
    expect(draft.thread_id).toBe(email.thread_id);

    const fetched = await asJson(await get(stub, `/drafts/${draft.id}`));
    expect(fetched.draft.id).toBe(draft.id);
    expect(fetched.draft.to_addr).toBe("sender@example.com");
    expect((await get(stub, "/drafts/drf-nope")).status).toBe(404);

    const patched = await asJson(await send(stub, "PATCH", `/drafts/${draft.id}`, {
      body_text: "thanks — revised",
    }));
    expect(patched.draft.body_text).toBe("thanks — revised");
    expect((await send(stub, "PATCH", "/drafts/drf-nope", { subject: "x" })).status).toBe(404);
    expect(
      (await send(stub, "PATCH", `/drafts/${draft.id}`, { status: "queued" })).status,
    ).toBe(400);

    const list = await asJson(await get(stub, "/drafts"));
    expect(list.drafts).toHaveLength(1);
    expect((await asJson(await get(stub, "/drafts?status=sent"))).drafts).toHaveLength(0);
    expect((await get(stub, "/drafts?status=bogus")).status).toBe(400);
  });

  it("POST /drafts/:id/queue transitions once and only from 'draft'", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    const created = await send(stub, "POST", "/drafts", {
      to_addr: "sender@example.com",
      subject: "s",
      body_text: "b",
    });
    const { draft } = await asJson(created);

    const queued = await asJson(await send(stub, "POST", `/drafts/${draft.id}/queue`, {}));
    expect(queued.draft.status).toBe("queued");
    // Second queue is a 400, and the queued row refuses edits — the
    // approval gate owns the row from here.
    expect((await send(stub, "POST", `/drafts/${draft.id}/queue`, {})).status).toBe(400);
    expect(
      (await send(stub, "PATCH", `/drafts/${draft.id}`, { subject: "sneak" })).status,
    ).toBe(400);
    expect((await send(stub, "POST", "/drafts/drf-nope/queue", {})).status).toBe(404);
    expect((await get(stub, `/drafts/${draft.id}/queue`)).status).toBe(405);
  });

  it("POST /drafts/:id/unqueue releases a queued draft back to 'draft'", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    const created = await send(stub, "POST", "/drafts", {
      to_addr: "sender@example.com",
      subject: "s",
      body_text: "b",
    });
    const { draft } = await asJson(created);
    // Non-queued rows reject the release seam.
    expect((await send(stub, "POST", `/drafts/${draft.id}/unqueue`, {})).status).toBe(400);
    await send(stub, "POST", `/drafts/${draft.id}/queue`, {});
    const released = await asJson(await send(stub, "POST", `/drafts/${draft.id}/unqueue`, {}));
    expect(released.draft.status).toBe("draft");
    // Released rows can be queued again — the gate owns them only while queued.
    expect((await send(stub, "POST", `/drafts/${draft.id}/queue`, {})).status).toBe(200);
    expect((await send(stub, "POST", "/drafts/drf-nope/unqueue", {})).status).toBe(404);
    expect((await get(stub, `/drafts/${draft.id}/unqueue`)).status).toBe(405);
  });

  it("POST /drafts/:id/sent transitions once and only from 'queued'", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    const created = await send(stub, "POST", "/drafts", {
      to_addr: "sender@example.com",
      subject: "s",
      body_text: "b",
    });
    const { draft } = await asJson(created);
    // Only a queued row may become `sent` — a live draft refuses.
    expect((await send(stub, "POST", `/drafts/${draft.id}/sent`, {})).status).toBe(400);
    await send(stub, "POST", `/drafts/${draft.id}/queue`, {});
    const sent = await asJson(await send(stub, "POST", `/drafts/${draft.id}/sent`, {}));
    expect(sent.draft.status).toBe("sent");
    // `sent` is terminal: no re-mark, no unqueue back, no re-queue, no edit.
    expect((await send(stub, "POST", `/drafts/${draft.id}/sent`, {})).status).toBe(400);
    expect((await send(stub, "POST", `/drafts/${draft.id}/unqueue`, {})).status).toBe(400);
    expect((await send(stub, "POST", `/drafts/${draft.id}/queue`, {})).status).toBe(400);
    expect(
      (await send(stub, "PATCH", `/drafts/${draft.id}`, { subject: "sneak" })).status,
    ).toBe(400);
    expect((await send(stub, "POST", "/drafts/drf-nope/sent", {})).status).toBe(404);
    expect((await get(stub, `/drafts/${draft.id}/sent`)).status).toBe(405);
  });
});

describe("mailbox meta", () => {
  it("reports address, registration, and counts — delegated to the directory", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    await seedEmail(stub);
    await send(stub, "POST", "/drafts", {
      to_addr: "sender@example.com",
      subject: "d",
      body_text: "b",
    });

    let meta = await asJson(await get(stub, "/mailbox"));
    expect(meta.address).toBe("agent@shiba.dev");
    expect(meta.registered).toBe(false);
    expect(meta.mailbox).toBeNull();
    expect(meta.stats).toMatchObject({ emails: 1, unread: 1, drafts: 1 });

    await send(h.directory, "POST", "/mailboxes", { address: "agent@shiba.dev" });
    meta = await asJson(await get(stub, "/mailbox"));
    expect(meta.registered).toBe(true);
    expect(meta.mailbox?.address).toBe("agent@shiba.dev");
  });

  it("on the directory stub includes the full registry listing", async () => {
    const h = makeHarness();
    await send(h.directory, "POST", "/mailboxes", { address: "agent@shiba.dev" });
    const meta = await asJson(await get(h.directory, "/mailbox"));
    expect(meta.address).toBe(MAILBOX_DIRECTORY_NAME);
    expect(meta.mailboxes).toHaveLength(1);
  });
});

describe("route hygiene", () => {
  it("404s unknown and out-of-prefix paths, 400s bad bodies", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    expect((await get(stub, "/nope")).status).toBe(404);
    expect((await stub.fetch(new Request("https://internal/other/emails"))).status).toBe(404);
    expect(
      (
        await stub.fetch(
          new Request(`${BASE}/emails`, { method: "POST", body: "not json" }),
        )
      ).status,
    ).toBe(400);
    expect((await send(stub, "POST", "/emails", { direction: "inbound" })).status).toBe(400);
    expect((await stub.fetch(new Request(`${BASE}/emails`, { method: "PUT" }))).status).toBe(
      405,
    );
  });

  it("405s known paths with the wrong method, 404s unknown ones", async () => {
    const h = makeHarness();
    const stub = h.stub("agent@shiba.dev");
    expect((await send(h.directory, "POST", "/mailboxes/agent@shiba.dev", {})).status).toBe(
      405,
    );
    expect((await get(stub, "/emails/eml-x/read")).status).toBe(405);
    expect((await get(stub, "/emails/eml-x/move")).status).toBe(405);
    expect((await get(stub, "/drafts/drf-x")).status).toBe(404);
    expect((await send(stub, "PUT", "/drafts/drf-x", {})).status).toBe(405);
    expect((await send(stub, "POST", "/threads/thr-x")).status).toBe(405);
    expect((await send(stub, "POST", "/mailbox")).status).toBe(405);
    expect((await get(stub, "/emails/eml-x/nope")).status).toBe(404);
    expect((await get(stub, "/drafts/drf-x/extra")).status).toBe(404);
  });
});
