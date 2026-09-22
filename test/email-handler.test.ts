import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  handleInboundEmail,
  inboundEmailStats,
  PARSE_FAILED_FLAG,
  resetInboundEmailStats,
} from "../src/email-handler.js";
import type { Env } from "../src/env.js";
import { MAILBOX_DIRECTORY_NAME, Mailbox } from "../src/mailbox-do.js";
import type { SqlRow, StoredAttachment, StoredEmail } from "../src/mailbox-store.js";

/**
 * Pure-boundary harness: the handler's only seams are `env.Mailbox` (real
 * `Mailbox` DOs faked over `node:sqlite`, like mailbox-do.test.ts) and
 * `env.ATTACHMENTS` (an in-memory R2 bucket). Synthetic RFC822 strings go in
 * as `ForwardableEmailMessage` fakes — no workerd, no network.
 */

const REGISTERED = "agent@shiba.dev";

interface FakeR2Object {
  key: string;
  content: Uint8Array;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

type FakeStub = { fetch: (r: Request) => Promise<Response> };

function makeEnv(): Env & { r2: Map<string, FakeR2Object>; stubs: Map<string, FakeStub> } {
  const stubs = new Map<string, FakeStub>();
  const r2 = new Map<string, FakeR2Object>();
  const env = {
    Mailbox: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name?: string }) => {
        const name = id.name ?? "";
        let stub = stubs.get(name);
        if (!stub) {
          const db = new DatabaseSync(":memory:");
          const ctx = {
            id: { name },
            storage: {
              sql: {
                exec: (sql: string, ...params: unknown[]) => ({
                  toArray: () => db.prepare(sql).all(...(params as any[])) as SqlRow[],
                }),
              },
            },
            blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
            waitUntil: () => {},
          };
          const obj = new Mailbox(ctx as unknown as DurableObjectState, env as unknown as Env);
          stub = { fetch: (request: Request) => obj.fetch(request) };
          stubs.set(name, stub);
        }
        return stub;
      },
    },
    ATTACHMENTS: {
      put: async (key: string, value: unknown, opts?: FakeR2Object) => {
        const bytes =
          value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : ArrayBuffer.isView(value)
              ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
              : new TextEncoder().encode(String(value));
        r2.set(key, { key, content: bytes, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata });
      },
      get: async (key: string) => r2.get(key) ?? null,
    },
  };
  const typed = env as unknown as Env & {
    r2: Map<string, FakeR2Object>;
    stubs: Map<string, FakeStub>;
  };
  typed.r2 = r2;
  typed.stubs = stubs;
  return typed;
}

interface FakeMessage {
  message: ForwardableEmailMessage;
  rejectReason: () => string | undefined;
}

function makeMessage(raw: string | ReadableStream<Uint8Array>, over: { to?: string; from?: string; headers?: Record<string, string> } = {}): FakeMessage {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : null;
  let rejected: string | undefined;
  const message = {
    from: over.from ?? "sender@example.com",
    to: over.to ?? REGISTERED,
    raw: typeof raw === "string" ? new ReadableStream({ start: (c) => { c.enqueue(bytes!); c.close(); } }) : raw,
    rawSize: bytes?.byteLength ?? 0,
    headers: new Headers(over.headers ?? {}),
    setReject: (reason: string) => { rejected = reason; },
    forward: async () => ({}),
    reply: async () => ({}),
  } as unknown as ForwardableEmailMessage;
  return { message, rejectReason: () => rejected };
}

async function registerMailbox(env: Env, address = REGISTERED): Promise<void> {
  const res = await (env.Mailbox.get(env.Mailbox.idFromName("__directory__")) as unknown as {
    fetch: (r: Request) => Promise<Response>;
  }).fetch(
    new Request("https://internal/internal/mailbox/mailboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    }),
  );
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
}

async function listEmails(env: Env, address = REGISTERED): Promise<StoredEmail[]> {
  const res = await (env.Mailbox.get(env.Mailbox.idFromName(address)) as unknown as {
    fetch: (r: Request) => Promise<Response>;
  }).fetch(new Request("https://internal/internal/mailbox/emails"));
  return ((await res.json()) as { emails: StoredEmail[] }).emails;
}

async function getEmailDetail(
  env: Env,
  id: string,
  address = REGISTERED,
): Promise<{ email: StoredEmail; attachments: StoredAttachment[] }> {
  const res = await (env.Mailbox.get(env.Mailbox.idFromName(address)) as unknown as {
    fetch: (r: Request) => Promise<Response>;
  }).fetch(new Request(`https://internal/internal/mailbox/emails/${id}`));
  return (await res.json()) as { email: StoredEmail; attachments: StoredAttachment[] };
}

function rfc822(headers: Record<string, string>, body = ""): string {
  return `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${body}`;
}

describe("handleInboundEmail", () => {
  it("rejects + counts mail to an unregistered recipient without storing", async () => {
    resetInboundEmailStats();
    const env = makeEnv();
    await registerMailbox(env);
    const { message, rejectReason } = makeMessage(rfc822({ Subject: "hi" }), { to: "nobody@shiba.dev" });
    await handleInboundEmail(message, env);
    expect(rejectReason()).toBe("Unknown address");
    expect(inboundEmailStats().unregisteredDrops).toBe(1);
    expect(await listEmails(env)).toHaveLength(0);
  });

  it("stores a registered inbound email with subject/text/from", async () => {
    resetInboundEmailStats();
    const env = makeEnv();
    await registerMailbox(env);
    const { message, rejectReason } = makeMessage(
      rfc822({ From: "Friend <pal@example.com>", To: REGISTERED, Subject: "Deploy report", "Message-ID": "<m1@example.com>" }, "the deploy finished at noon"),
    );
    await handleInboundEmail(message, env);
    expect(rejectReason()).toBeUndefined();
    const emails = await listEmails(env);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      direction: "inbound",
      from_addr: "pal@example.com",
      to_addr: REGISTERED,
      subject: "Deploy report",
      status: "unread",
    });
    expect(emails[0]?.body_text?.trim()).toBe("the deploy finished at noon");
    expect(inboundEmailStats().stored).toBe(1);
  });

  it("decodes multipart/alternative with a base64 text part", async () => {
    const env = makeEnv();
    await registerMailbox(env);
    const raw =
      `From: a@example.com\nTo: ${REGISTERED}\nSubject: b64test\nMIME-Version: 1.0\n` +
      `Content-Type: multipart/alternative; boundary=x\n\n` +
      `--x\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\naGVsbG8gd29ybGQ=\n\n` +
      `--x\nContent-Type: text/html; charset=utf-8\n\n<p>hi</p>\n\n--x--\n`;
    await handleInboundEmail(makeMessage(raw).message, env);
    const [email] = await listEmails(env);
    expect(email?.body_text).toBe("hello world");
    expect(email?.body_html).toContain("<p>hi</p>");
    expect(email?.subject).toBe("b64test");
  });

  it("stores a '(no subject)' placeholder when Subject is missing", async () => {
    const env = makeEnv();
    await registerMailbox(env);
    await handleInboundEmail(makeMessage(rfc822({ From: "a@example.com", To: REGISTERED }, "body only")).message, env);
    const [email] = await listEmails(env);
    expect(email?.subject).toBe("(no subject)");
    expect(email?.body_text).toContain("body only");
  });

  it("threads a reply onto the original via In-Reply-To", async () => {
    const env = makeEnv();
    await registerMailbox(env);
    await handleInboundEmail(
      makeMessage(rfc822({ From: "a@example.com", To: REGISTERED, Subject: "question?", "Message-ID": "<orig@x>" }, "first")).message,
      env,
    );
    // A divergent subject rules out the subject-normalization fallback —
    // this pair threads only if the In-Reply-To message-id lookup hits.
    await handleInboundEmail(
      makeMessage(rfc822({ From: "b@example.com", To: REGISTERED, Subject: "totally different topic", "Message-ID": "<reply@x>", "In-Reply-To": "<orig@x>" }, "second")).message,
      env,
    );
    const emails = await listEmails(env);
    expect(emails).toHaveLength(2);
    expect(emails[0]?.thread_id).toBe(emails[1]?.thread_id);
  });

  it("normalizes a display-name recipient before the registry check", async () => {
    const env = makeEnv();
    await registerMailbox(env);
    const { message, rejectReason } = makeMessage(rfc822({ Subject: "hi" }), { to: " Agent <Agent@Shiba.dev> " });
    await handleInboundEmail(message, env);
    expect(rejectReason()).toBeUndefined();
    expect(await listEmails(env)).toHaveLength(1);
  });

  it("captures attachments into R2 keyed emailId/part-N plus a manifest row", async () => {
    const env = makeEnv();
    await registerMailbox(env);
    const raw =
      `From: a@example.com\nTo: ${REGISTERED}\nSubject: with file\nMIME-Version: 1.0\n` +
      `Content-Type: multipart/mixed; boundary=y\n\n` +
      `--y\nContent-Type: text/plain; charset=utf-8\n\nsee attached\n\n` +
      `--y\nContent-Type: text/csv; name="data.csv"\nContent-Disposition: attachment; filename="data.csv"\nContent-Transfer-Encoding: base64\n\nY29sMSxjb2wyCjEsMgo=\n\n--y--\n`;
    await handleInboundEmail(makeMessage(raw).message, env);
    const [email] = await listEmails(env);
    expect(email).toBeTruthy();
    const obj = env.r2.get(`${email!.id}/part-0`);
    expect(obj).toBeTruthy();
    expect(new TextDecoder().decode(obj!.content)).toBe("col1,col2\n1,2\n");
    expect(obj!.customMetadata?.filename).toBe("data.csv");
    expect(obj!.httpMetadata?.contentType).toContain("text/csv");
    // The manifest row is what consumers (get_email, InboxTab) read — no
    // R2 list + HEAD needed to learn a part's name, type, size, or key.
    const { attachments } = await getEmailDetail(env, email!.id);
    expect(attachments).toEqual([
      {
        part_id: "part-0",
        filename: "data.csv",
        mime_type: "text/csv",
        size: "col1,col2\n1,2\n".length,
        content_id: null,
        r2_key: `${email!.id}/part-0`,
      },
    ]);
  });

  it("rejects a registered recipient when the store write fails", async () => {
    resetInboundEmailStats();
    const env = makeEnv();
    await registerMailbox(env);
    // The directory answers normally (registered) but the per-address mail
    // stub errors — the message clears the gate then dies at the store.
    env.stubs.set(REGISTERED, {
      fetch: async () => new Response("broken", { status: 500 }),
    });
    const { message, rejectReason } = makeMessage(
      rfc822({ From: "a@example.com", To: REGISTERED, Subject: "x" }),
    );
    await handleInboundEmail(message, env);
    expect(rejectReason()).toBe("Mailbox storage failed");
    expect(inboundEmailStats().stored).toBe(0);
  });

  it("counts directory lookup failures apart from unregistered drops", async () => {
    resetInboundEmailStats();
    const env = makeEnv();
    env.stubs.set(MAILBOX_DIRECTORY_NAME, {
      fetch: async () => new Response("broken", { status: 500 }),
    });
    const { message, rejectReason } = makeMessage(rfc822({ Subject: "x" }));
    await handleInboundEmail(message, env);
    expect(rejectReason()).toBe("Unknown address");
    expect(inboundEmailStats().directoryErrors).toBe(1);
    expect(inboundEmailStats().unregisteredDrops).toBe(0);
  });

  it("flags and stores unparseable mail with the raw subject, never crashing", async () => {
    resetInboundEmailStats();
    const env = makeEnv();
    await registerMailbox(env);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // >256 nested multiparts exceed postal-mime's maxNestingDepth — a
      // deterministic parse failure.
      let raw = "Subject: raw subject kept\nFrom: a@example.com\nMIME-Version: 1.0\n";
      for (let i = 0; i < 300; i++) {
        raw += `Content-Type: multipart/mixed; boundary=b${i}\n\n--b${i}\n`;
      }
      const { message, rejectReason } = makeMessage(raw, {
        headers: { Subject: "raw subject kept", From: "a@example.com", "Message-ID": "<deep@x>" },
      });
      await handleInboundEmail(message, env);
      expect(rejectReason()).toBeUndefined();
      const [email] = await listEmails(env);
      expect(email?.subject).toBe("raw subject kept");
      expect(email?.body_text).toContain(PARSE_FAILED_FLAG);
      expect(inboundEmailStats().parseFailed).toBe(1);
      // The parse exception is logged — the flag + raw dump aren't the only trace.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("inbound_email_parse_failed"));
      const rawObj = env.r2.get(`${email!.id}/raw-source`);
      expect(rawObj).toBeTruthy();
      expect(rawObj!.httpMetadata?.contentType).toBe("message/rfc822");
      // The dump is recorded in the manifest like a MIME part.
      const { attachments } = await getEmailDetail(env, email!.id);
      expect(attachments).toEqual([
        expect.objectContaining({
          part_id: "raw-source",
          mime_type: "message/rfc822",
          r2_key: `${email!.id}/raw-source`,
        }),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("flags and stores when the raw stream errors mid-read", async () => {
    const env = makeEnv();
    await registerMailbox(env);
    const badStream = new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(new TextEncoder().encode("partial"));
        c.error(new Error("stream broke"));
      },
    });
    const { message, rejectReason } = makeMessage(badStream, { headers: { Subject: "still stored" } });
    await handleInboundEmail(message, env);
    expect(rejectReason()).toBeUndefined();
    const [email] = await listEmails(env);
    expect(email?.subject).toBe("still stored");
    expect(email?.body_text).toContain(PARSE_FAILED_FLAG);
  });
});
