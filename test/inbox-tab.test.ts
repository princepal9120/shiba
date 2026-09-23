import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
// Orchestrator stub registry: /api/approvals tests plug per-name
// responders in; the default no-op keeps every other route unaffected.
const orchestratorCalls = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; url: string; method: string; body: string | undefined }>,
  handlers: {} as Record<string, (request: Request) => Promise<Response>>,
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_ns: unknown, name: string) => ({
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      let body: string | undefined;
      if (init?.body !== undefined) body = String(init.body);
      else if (input instanceof Request && input.method !== "GET") body = await input.text();
      orchestratorCalls.calls.push({ name, url, method, body });
      const handler = orchestratorCalls.handlers[name];
      if (!handler) return new Response("{}", { status: 404 });
      return handler(input instanceof Request ? input : new Request(url, init));
    },
  }),
  routeAgentRequest: async () => null,
}));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return { fetch: async () => Response.json({ mcp: "served" }) };
    }
  },
}));

// The approval seam is a stub until T7 lands the real bridge — capture calls
// so the test asserts the frozen send payload, not the stub's internals.
const queuedApprovals = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; mailbox: string; payload: Record<string, unknown> }>,
  bridgeReady: true,
  error: null as Error | null,
}));
vi.mock("../src/email-approvals.js", () => ({
  queueEmailApproval: async (_env: unknown, request: { kind: string; mailbox: string; payload: Record<string, unknown> }) => {
    if (queuedApprovals.error) throw queuedApprovals.error;
    queuedApprovals.calls.push(request);
    return { approval_id: "apv-test-1" };
  },
  emailApprovalBridgeReady: () => queuedApprovals.bridgeReady,
}));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { InboxTab, replyAddress, replyMailbox } from "../src/dashboard/components/InboxTab";
import { MemoryTab } from "../src/dashboard/components/MemoryTab";

interface FakeStub {
  calls: Array<{ url: string; method: string; body: string | undefined }>;
  fetch: (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
}

interface FakeRoute {
  method?: string;
  match: string | RegExp;
  body: unknown;
  status?: number;
}

function makeStub(routes: FakeRoute[]): FakeStub {
  const calls: FakeStub["calls"] = [];
  const fetch: FakeStub["fetch"] = async (input, init) => {
    const url =
      input instanceof Request ? input.url : typeof input === "string" ? input : input.toString();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body === undefined ? undefined : String(init.body);
    calls.push({ url, method, body });
    const path = new URL(url).pathname;
    for (const route of routes) {
      const matched =
        typeof route.match === "string" ? path === route.match : route.match.test(path);
      if (matched && (route.method === undefined || route.method === method)) {
        return Response.json(route.body, { status: route.status ?? 200 });
      }
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  };
  return { calls, fetch };
}

function makeNamespace(stubs: Record<string, FakeStub>) {
  return {
    idFromName: (name: string) => name,
    get: (name: string) => {
      const stub = stubs[name];
      if (stub === undefined) {
        throw new Error(`unexpected stub ${name}`);
      }
      return stub;
    },
  };
}

const DIRECTORY = "__directory__";

function makeEnv(stubs: Record<string, FakeStub>, opts: { memory?: Record<string, FakeStub> } = {}) {
  const env = {
    Mailbox: makeNamespace(stubs),
    ...(opts.memory ? { Memory: makeNamespace(opts.memory) } : {}),
  } as unknown as Env;
  return env;
}

const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

const emailA = {
  id: "eml-a1",
  thread_id: "thr-1",
  direction: "inbound" as const,
  from_addr: "alice@example.com",
  to_addr: "agent-a@shiba.dev",
  subject: "Deploy request",
  body_text: "please deploy",
  body_html: null,
  status: "unread",
  created_at: 1000,
};
const emailB = {
  id: "eml-b1",
  thread_id: "thr-9",
  direction: "inbound" as const,
  from_addr: "bob@example.com",
  to_addr: "agent-b@shiba.dev",
  subject: "Newer mail",
  body_text: "hi",
  body_html: null,
  status: "read",
  created_at: 2000,
};
const draftA = {
  id: "drf-1",
  thread_id: "thr-1",
  to_addr: "alice@example.com",
  subject: "Re: Deploy request",
  body_text: "on it",
  status: "draft",
  created_at: 1500,
  updated_at: 1500,
};

function makeEnvWithTwoMailboxes() {
  const directory = makeStub([
    {
      match: "/internal/mailbox/mailboxes",
      body: {
        mailboxes: [
          { address: "agent-a@shiba.dev", label: "A", agent: "a", created_at: 1 },
          { address: "agent-b@shiba.dev", label: "B", agent: "b", created_at: 2 },
        ],
      },
    },
  ]);
  const stubA = makeStub([
    { match: /^\/internal\/mailbox\/emails$/, body: { emails: [emailA] } },
    { match: /^\/internal\/mailbox\/emails\/search$/, body: { emails: [emailA] } },
    { match: "/internal/mailbox/emails/eml-a1", body: { email: emailA, attachments: [{ part_id: "p1", filename: "a.pdf", mime_type: "application/pdf", size: 1234, content_id: "cid-1", r2_key: "eml-a1/p1" }] } },
    { match: "/internal/mailbox/threads/thr-1", body: { thread: { id: "thr-1", subject: "Deploy request", last_message_at: 1000, emails: [emailA] } } },
    { method: "POST", match: "/internal/mailbox/drafts", body: { draft: draftA }, status: 201 },
    { match: /^\/internal\/mailbox\/drafts$/, body: { drafts: [draftA] } },
    { match: "/internal/mailbox/drafts/drf-1", body: { draft: draftA } },
    { method: "POST", match: "/internal/mailbox/drafts/drf-1/queue", body: { draft: { ...draftA, status: "queued" } } },
    { method: "POST", match: "/internal/mailbox/emails/eml-a1/read", body: { email: { ...emailA, status: "read" }, changed: true } },
  ]);
  const stubB = makeStub([
    { match: /^\/internal\/mailbox\/emails$/, body: { emails: [emailB] } },
    { match: /^\/internal\/mailbox\/emails\/search$/, body: { emails: [] } },
    { match: /^\/internal\/mailbox\/drafts$/, body: { drafts: [] } },
  ]);
  const env = makeEnv({ [DIRECTORY]: directory, "agent-a@shiba.dev": stubA, "agent-b@shiba.dev": stubB });
  return { env, directory, stubA, stubB };
}

describe("dashboard inbox routes", () => {
  it("GET /api/mailboxes lists the registered mailboxes from the directory stub", async () => {
    const { env, directory } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(new Request("https://worker/api/mailboxes"), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mailboxes: Array<{ address: string }> };
    expect(body.mailboxes.map((m) => m.address)).toEqual([
      "agent-a@shiba.dev",
      "agent-b@shiba.dev",
    ]);
    expect(directory.calls.map((c) => c.url)).toEqual([
      "https://internal/internal/mailbox/mailboxes",
    ]);
  });

  it("GET /api/emails fans out across mailboxes, tags each row, sorts newest first", async () => {
    const { env, stubA, stubB } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(new Request("https://worker/api/emails"), env, ctx);
    const body = (await response.json()) as { emails: Array<{ id: string; mailbox: string }> };
    expect(body.emails.map((e) => e.id)).toEqual(["eml-b1", "eml-a1"]);
    expect(body.emails[0]!.mailbox).toBe("agent-b@shiba.dev");
    expect(body.emails[1]!.mailbox).toBe("agent-a@shiba.dev");
    expect(stubA.calls).toHaveLength(1);
    expect(stubB.calls).toHaveLength(1);
  });

  it("GET /api/emails?mailbox= targets only that mailbox stub", async () => {
    const { env, stubA, stubB } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(
      new Request("https://worker/api/emails?mailbox=agent-a@shiba.dev&status=unread"),
      env,
      ctx,
    );
    const body = (await response.json()) as { mailbox: string; emails: unknown[] };
    expect(body.mailbox).toBe("agent-a@shiba.dev");
    expect(body.emails).toHaveLength(1);
    expect(stubA.calls[0]!.url).toBe(
      "https://internal/internal/mailbox/emails?status=unread&limit=50",
    );
    expect(stubB.calls).toHaveLength(0);
  });

  it("GET read routes reject an unregistered ?mailbox= without instantiating its stub", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    for (const path of [
      "/api/emails?mailbox=ghost@shiba.dev",
      "/api/emails-search?q=hi&mailbox=ghost@shiba.dev",
      "/api/drafts?mailbox=ghost@shiba.dev",
    ]) {
      const response = await worker.fetch(new Request(`https://worker${path}`), env, ctx);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("not a registered mailbox");
    }
  });

  it("GET /api/emails/:id probes mailboxes until one owns the id", async () => {
    const { env, stubA, stubB } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(new Request("https://worker/api/emails/eml-a1"), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mailbox: string; email: { id: string }; attachments: unknown[] };
    expect(body.mailbox).toBe("agent-a@shiba.dev");
    expect(body.email.id).toBe("eml-a1");
    expect(stubA.calls.some((c) => c.url.endsWith("/emails/eml-a1"))).toBe(true);
    expect(stubB.calls).toHaveLength(0);
  });

  it("GET /api/emails/:id strips internal storage fields from attachments", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(new Request("https://worker/api/emails/eml-a1"), env, ctx);
    const body = (await response.json()) as { attachments: Array<Record<string, unknown>> };
    expect(body.attachments).toEqual([
      { part_id: "p1", filename: "a.pdf", mime_type: "application/pdf", size: 1234 },
    ]);
  });

  it("GET /api/emails/:id returns 404 when no registered mailbox owns it", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(new Request("https://worker/api/emails/eml-none"), env, ctx);
    expect(response.status).toBe(404);
  });

  it("POST /api/emails/:id/read marks the email read on its owning mailbox", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(
      new Request("https://worker/api/emails/eml-a1/read", { method: "POST" }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mailbox: string; email: { status: string } };
    expect(body.mailbox).toBe("agent-a@shiba.dev");
    expect(body.email.status).toBe("read");
  });

  it("GET /api/threads/:id returns the owning mailbox's thread view", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(new Request("https://worker/api/threads/thr-1"), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mailbox: string; thread: { emails: unknown[] } };
    expect(body.mailbox).toBe("agent-a@shiba.dev");
    expect(body.thread.emails).toHaveLength(1);
  });

  it("GET /api/emails-search requires q and merges fan-out results", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const missing = await worker.fetch(new Request("https://worker/api/emails-search"), env, ctx);
    expect(missing.status).toBe(400);
    const response = await worker.fetch(
      new Request("https://worker/api/emails-search?q=deploy"),
      env,
      ctx,
    );
    const body = (await response.json()) as { emails: Array<{ id: string; mailbox: string }> };
    expect(body.emails).toHaveLength(1);
    expect(body.emails[0]!.mailbox).toBe("agent-a@shiba.dev");
  });

  it("GET /api/drafts fans out and tags each draft with its mailbox", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(new Request("https://worker/api/drafts"), env, ctx);
    const body = (await response.json()) as { drafts: Array<{ id: string; mailbox: string }> };
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]!.mailbox).toBe("agent-a@shiba.dev");
  });

  it("POST /api/drafts creates a reply draft only on a registered mailbox", async () => {
    const { env, stubA } = makeEnvWithTwoMailboxes();
    const bad = await worker.fetch(
      new Request("https://worker/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailbox: "nobody@shiba.dev", to_addr: "x@y", subject: "s", body_text: "b" }),
      }),
      env,
      ctx,
    );
    expect(bad.status).toBe(400);
    stubA.calls.length = 0;
    const response = await worker.fetch(
      new Request("https://worker/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox: "agent-a@shiba.dev",
          to_addr: "alice@example.com",
          subject: "Re: Deploy request",
          body_text: "on it",
          thread_id: "thr-1",
        }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(201);
    expect(stubA.calls).toHaveLength(1);
    expect(stubA.calls[0]!.method).toBe("POST");
    expect(stubA.calls[0]!.url).toBe("https://internal/internal/mailbox/drafts");
    expect(JSON.parse(stubA.calls[0]!.body!)).toMatchObject({ thread_id: "thr-1" });
  });

  it("POST /api/drafts rejects malformed JSON and non-object bodies with 400", async () => {
    const { env, stubA } = makeEnvWithTwoMailboxes();
    for (const raw of ["{not json", "null", "[1,2]", "\"text\""]) {
      const response = await worker.fetch(
        new Request("https://worker/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: raw,
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(400);
    }
    expect(stubA.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("POST /api/drafts answers the normalized registered mailbox, not the caller's casing", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(
      new Request("https://worker/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox: " Agent-A@SHIBA.DEV ",
          to_addr: "alice@example.com",
          subject: "Re: Deploy request",
          body_text: "on it",
        }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { mailbox: string };
    expect(body.mailbox).toBe("agent-a@shiba.dev");
  });

  it("POST /api/drafts/:id/send refuses while the approval bridge is unwired", async () => {
    queuedApprovals.calls.length = 0;
    queuedApprovals.bridgeReady = false;
    const { env, stubA } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(
      new Request("https://worker/api/drafts/drf-1/send", { method: "POST" }),
      env,
      ctx,
    );
    expect(response.status).toBe(503);
    expect(queuedApprovals.calls).toHaveLength(0);
    // The draft is never locked — no /queue call reaches its mailbox.
    expect(
      stubA.calls.some((c) => c.url.endsWith("/internal/mailbox/drafts/drf-1/queue")),
    ).toBe(false);
    queuedApprovals.bridgeReady = true;
  });

  it("POST /api/drafts/:id/send queues an approval and locks the draft — it never transmits", async () => {
    queuedApprovals.calls.length = 0;
    queuedApprovals.bridgeReady = true;
    const { env, stubA } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(
      new Request("https://worker/api/drafts/drf-1/send", { method: "POST" }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      kind: string;
      mailbox: string;
      approval_id: string;
      draft: { status: string };
    };
    expect(body.status).toBe("pending_approval");
    expect(body.kind).toBe("email_send");
    expect(body.mailbox).toBe("agent-a@shiba.dev");
    expect(body.approval_id).toBe("apv-test-1");
    expect(body.draft.status).toBe("queued");
    expect(queuedApprovals.calls).toEqual([
      {
        kind: "email_send",
        mailbox: "agent-a@shiba.dev",
        payload: {
          to_addr: "alice@example.com",
          subject: "Re: Deploy request",
          body_text: "on it",
          thread_id: "thr-1",
          draft_id: "drf-1",
        },
      },
    ]);
    expect(
      stubA.calls.some(
        (c) => c.method === "POST" && c.url.endsWith("/internal/mailbox/drafts/drf-1/queue"),
      ),
    ).toBe(true);
  });

  it("POST /api/drafts/:id/send freezes the payload the queue CAS locked, not the earlier read", async () => {
    queuedApprovals.calls.length = 0;
    queuedApprovals.bridgeReady = true;
    const directory = makeStub([
      { match: "/internal/mailbox/mailboxes", body: { mailboxes: [{ address: "agent-a@shiba.dev", label: null, agent: null, created_at: 1 }] } },
    ]);
    const stubA = makeStub([
      { match: "/internal/mailbox/drafts/drf-1", body: { draft: draftA } },
      // A PATCH racing in ahead of the CAS lands inside the lock — the
      // approval must freeze this row, not the pre-lock read above.
      { method: "POST", match: "/internal/mailbox/drafts/drf-1/queue", body: { draft: { ...draftA, body_text: "edited just before queue", status: "queued" } } },
    ]);
    const env = makeEnv({ [DIRECTORY]: directory, "agent-a@shiba.dev": stubA });
    const response = await worker.fetch(
      new Request("https://worker/api/drafts/drf-1/send", { method: "POST" }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(queuedApprovals.calls[0]!.payload).toMatchObject({
      body_text: "edited just before queue",
      draft_id: "drf-1",
    });
  });

  it("POST /api/drafts/:id/send mints no approval when the queue CAS fails", async () => {
    queuedApprovals.calls.length = 0;
    queuedApprovals.bridgeReady = true;
    const directory = makeStub([
      { match: "/internal/mailbox/mailboxes", body: { mailboxes: [{ address: "agent-a@shiba.dev", label: null, agent: null, created_at: 1 }] } },
    ]);
    const stubA = makeStub([
      { match: "/internal/mailbox/drafts/drf-1", body: { draft: draftA } },
      // Concurrent discard: the CAS refuses — the request must fail without
      // leaving a resolvable approval behind.
      { method: "POST", match: "/internal/mailbox/drafts/drf-1/queue", body: { error: "draft is 'discarded'" }, status: 400 },
    ]);
    const env = makeEnv({ [DIRECTORY]: directory, "agent-a@shiba.dev": stubA });
    const response = await worker.fetch(
      new Request("https://worker/api/drafts/drf-1/send", { method: "POST" }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(queuedApprovals.calls).toHaveLength(0);
  });

  it("POST /api/drafts/:id/send surfaces a queue-CAS 404 as 404, not 400", async () => {
    queuedApprovals.calls.length = 0;
    const directory = makeStub([
      { match: "/internal/mailbox/mailboxes", body: { mailboxes: [{ address: "agent-a@shiba.dev", label: null, agent: null, created_at: 1 }] } },
    ]);
    const stubA = makeStub([
      { match: "/internal/mailbox/drafts/drf-1", body: { draft: draftA } },
      // The draft was deleted between the probe and the CAS — the DO's 404
      // must reach the caller as a 404.
      { method: "POST", match: "/internal/mailbox/drafts/drf-1/queue", body: { error: "Draft not found." }, status: 404 },
    ]);
    const env = makeEnv({ [DIRECTORY]: directory, "agent-a@shiba.dev": stubA });
    const response = await worker.fetch(
      new Request("https://worker/api/drafts/drf-1/send", { method: "POST" }),
      env,
      ctx,
    );
    expect(response.status).toBe(404);
    expect(queuedApprovals.calls).toHaveLength(0);
  });

  it("POST /api/drafts/:id/send unqueues the draft when the approval mint fails", async () => {
    queuedApprovals.calls.length = 0;
    queuedApprovals.bridgeReady = true;
    queuedApprovals.error = new Error("orchestrator unreachable");
    const directory = makeStub([
      { match: "/internal/mailbox/mailboxes", body: { mailboxes: [{ address: "agent-a@shiba.dev", label: null, agent: null, created_at: 1 }] } },
    ]);
    const stubA = makeStub([
      { match: "/internal/mailbox/drafts/drf-1", body: { draft: draftA } },
      { method: "POST", match: "/internal/mailbox/drafts/drf-1/queue", body: { draft: { ...draftA, status: "queued" } } },
      { method: "POST", match: "/internal/mailbox/drafts/drf-1/unqueue", body: { draft: draftA } },
    ]);
    const env = makeEnv({ [DIRECTORY]: directory, "agent-a@shiba.dev": stubA });
    try {
      const response = await worker.fetch(
        new Request("https://worker/api/drafts/drf-1/send", { method: "POST" }),
        env,
        ctx,
      );
      expect(response.status).toBe(500);
      // The compensating unqueue returned the row to `draft` — nothing may
      // strand `queued` behind an approval that does not exist.
      expect(
        stubA.calls.some(
          (c) => c.method === "POST" && c.url.endsWith("/internal/mailbox/drafts/drf-1/unqueue"),
        ),
      ).toBe(true);
    } finally {
      queuedApprovals.error = null;
    }
  });

  it("POST /api/drafts/:id/send rejects a non-draft row and unknown ids", async () => {
    queuedApprovals.calls.length = 0;
    queuedApprovals.bridgeReady = true;
    const directory = makeStub([
      { match: "/internal/mailbox/mailboxes", body: { mailboxes: [{ address: "agent-a@shiba.dev", label: null, agent: null, created_at: 1 }] } },
    ]);
    const stubA = makeStub([
      { match: "/internal/mailbox/drafts/drf-sent", body: { draft: { ...draftA, id: "drf-sent", status: "sent" } } },
    ]);
    const env = makeEnv({ [DIRECTORY]: directory, "agent-a@shiba.dev": stubA });
    const missing = await worker.fetch(
      new Request("https://worker/api/drafts/drf-none/send", { method: "POST" }),
      env,
      ctx,
    );
    expect(missing.status).toBe(404);
    const sent = await worker.fetch(
      new Request("https://worker/api/drafts/drf-sent/send", { method: "POST" }),
      env,
      ctx,
    );
    expect(sent.status).toBe(409);
    expect(queuedApprovals.calls.length).toBe(0);
  });

  it("answers 405 for unsupported methods and 503 when the binding is absent", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const post = await worker.fetch(new Request("https://worker/api/emails", { method: "POST" }), env, ctx);
    expect(post.status).toBe(405);
    const getSend = await worker.fetch(new Request("https://worker/api/drafts/drf-1/send"), env, ctx);
    expect(getSend.status).toBe(405);
    const noMailbox = { Mailbox: undefined } as unknown as Env;
    const unprovisioned = await worker.fetch(
      new Request("https://worker/api/mailboxes"),
      noMailbox,
      ctx,
    );
    expect(unprovisioned.status).toBe(503);
  });
});

describe("dashboard memory routes", () => {
  function memoryEnv() {
    const memoryStub = makeStub([
      { match: /^\/internal\/memory\/facts$/, body: { facts: [{ id: "fact-1", fact: "prefers pnpm", source: "run", agent: "intern", created_at: 42 }] } },
      { match: /^\/internal\/memory\/facts\/search$/, body: { facts: [{ id: "fact-1", fact: "prefers pnpm", source: "run", agent: "intern", score: 0.87, created_at: 42 }] } },
      { match: /^\/internal\/memory\/sessions$/, body: { sessions: [{ id: "ses-1", agent: "intern", started_at: 40, summary: "deployed api" }] } },
      { method: "DELETE", match: /^\/internal\/memory\/facts\/fact-1$/, body: { ok: true } },
    ]);
    const directory = makeStub([{ match: "/internal/mailbox/mailboxes", body: { mailboxes: [] } }]);
    const env = makeEnv({ [DIRECTORY]: directory }, { memory: { global: memoryStub } });
    return { env, memoryStub };
  }

  it("GET /api/memory/facts proxies the global registry stub", async () => {
    const { env, memoryStub } = memoryEnv();
    const response = await worker.fetch(new Request("https://worker/api/memory/facts"), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { facts: Array<{ id: string }> };
    expect(body.facts).toHaveLength(1);
    expect(memoryStub.calls[0]!.url).toContain("/internal/memory/facts");
  });

  it("GET /api/memory/facts?q= routes to recall search with the query", async () => {
    const { env, memoryStub } = memoryEnv();
    const response = await worker.fetch(
      new Request("https://worker/api/memory/facts?q=package+manager"),
      env,
      ctx,
    );
    const body = (await response.json()) as { facts: Array<{ score?: number }> };
    expect(body.facts[0]!.score).toBe(0.87);
    expect(memoryStub.calls[0]!.url).toBe(
      "https://internal/internal/memory/facts/search?q=package+manager",
    );
  });

  it("GET /api/memory/sessions proxies and DELETE /api/memory/facts/:id passes through", async () => {
    const { env, memoryStub } = memoryEnv();
    const sessions = await worker.fetch(new Request("https://worker/api/memory/sessions"), env, ctx);
    const body = (await sessions.json()) as { sessions: Array<{ id: string }> };
    expect(body.sessions[0]!.id).toBe("ses-1");
    const del = await worker.fetch(
      new Request("https://worker/api/memory/facts/fact-1", { method: "DELETE" }),
      env,
      ctx,
    );
    expect(del.status).toBe(200);
    expect(
      memoryStub.calls.some(
        (c) => c.method === "DELETE" && c.url.endsWith("/internal/memory/facts/fact-1"),
      ),
    ).toBe(true);
  });

  it("answers 503 while the Memory binding is unprovisioned", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(new Request("https://worker/api/memory/facts"), env, ctx);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not provisioned");
  });
});

describe("dashboard approval routes", () => {
  const approvalA = {
    threadKey: "default",
    approvalId: "apv-default-1",
    repoUrl: "agent-a@shiba.dev",
    task: "Send email to person@example.com: Status update",
    status: "pending",
    createdAt: 10,
    kind: "email_send",
    payload: { to_addr: "person@example.com", mailbox: "agent-a@shiba.dev" },
  };

  it("GET /api/approvals merges the caller's orchestrator with the default one", async () => {
    orchestratorCalls.calls.length = 0;
    orchestratorCalls.handlers = {
      "dev@example.com": async () =>
        Response.json({
          approvals: [
            { ...approvalA, approvalId: "apv-user-1", threadKey: "dev@example.com", kind: "run" },
          ],
        }),
      default: async () => Response.json({ approvals: [approvalA] }),
    };
    try {
      const { env } = makeEnvWithTwoMailboxes();
      const response = await worker.fetch(
        new Request("https://worker/api/approvals", {
          headers: { "CF-Access-Authenticated-User-Email": "dev@example.com" },
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { approvals: Array<{ approvalId: string }> };
      expect(body.approvals.map((a) => a.approvalId).sort()).toEqual(
        ["apv-user-1", "apv-default-1"].sort(),
      );
      // Both instances were probed, caller first.
      expect(orchestratorCalls.calls.map((c) => c.name)).toEqual(["dev@example.com", "default"]);
    } finally {
      orchestratorCalls.handlers = {};
    }
  });

  it("GET /api/approvals without an identity probes only the shared 'default' orchestrator", async () => {
    orchestratorCalls.calls.length = 0;
    orchestratorCalls.handlers = {
      default: async () => Response.json({ approvals: [approvalA] }),
    };
    try {
      const { env } = makeEnvWithTwoMailboxes();
      const response = await worker.fetch(new Request("https://worker/api/approvals"), env, ctx);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { approvals: Array<{ approvalId: string }> };
      expect(body.approvals.map((a) => a.approvalId)).toEqual(["apv-default-1"]);
      expect(orchestratorCalls.calls.map((c) => c.name)).toEqual(["default"]);
    } finally {
      orchestratorCalls.handlers = {};
    }
  });

  it("POST /api/approvals probes the caller's DO then 'default' until one resolves", async () => {
    orchestratorCalls.calls.length = 0;
    orchestratorCalls.handlers = {
      "dev@example.com": async () => Response.json({ result: "unknown" }),
      default: async () => Response.json({ result: "rejected" }),
    };
    try {
      const { env } = makeEnvWithTwoMailboxes();
      const response = await worker.fetch(
        new Request("https://worker/api/approvals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Access-Authenticated-User-Email": "dev@example.com",
          },
          body: JSON.stringify({
            threadKey: "default",
            approvalId: "apv-default-1",
            approved: false,
          }),
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(200);
      expect((await response.json()) as { result: string }).toEqual({ result: "rejected" });
      expect(orchestratorCalls.calls.map((c) => c.name)).toEqual(["dev@example.com", "default"]);
      const decided = JSON.parse(orchestratorCalls.calls[1]!.body!) as {
        decidedBy: string;
        approved: boolean;
        threadKey: string;
      };
      expect(decided).toMatchObject({ decidedBy: "dev@example.com", approved: false, threadKey: "default" });
    } finally {
      orchestratorCalls.handlers = {};
    }
  });

  it("POST /api/approvals answers 400 on a malformed decision body", async () => {
    const { env } = makeEnvWithTwoMailboxes();
    const response = await worker.fetch(
      new Request("https://worker/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadKey: "default" }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
  });
});

describe("InboxTab + MemoryTab SSR", () => {
  it("renders the loading state without a live backend", () => {
    const inbox = renderToStaticMarkup(
      React.createElement(InboxTab, { onOpenApprovals: () => {} }),
    );
    expect(inbox).toContain("Loading mail");
    const memory = renderToStaticMarkup(React.createElement(MemoryTab));
    expect(memory).toContain("Loading memory");
  });
});

describe("replyAddress", () => {
  it("answers the sender for inbound mail and the recipient for outbound", () => {
    expect(replyAddress({ ...emailA, direction: "inbound" })).toBe("alice@example.com");
    expect(replyAddress({ ...emailA, direction: "outbound" })).toBe("agent-a@shiba.dev");
  });
});

describe("replyMailbox", () => {
  it("uses the detail response's top-level mailbox when the filter is 'All mailboxes'", () => {
    const detail = { mailbox: "agent-a@shiba.dev", email: emailA };
    expect(replyMailbox(detail, "")).toBe("agent-a@shiba.dev");
  });

  it("falls back to the row's fan-out tag, then the mailbox filter", () => {
    const untagged = { mailbox: null, email: { ...emailA, mailbox: "agent-b@shiba.dev" } };
    expect(replyMailbox(untagged, "")).toBe("agent-b@shiba.dev");
    expect(replyMailbox({ mailbox: null, email: emailA }, "agent-a@shiba.dev")).toBe(
      "agent-a@shiba.dev",
    );
    expect(replyMailbox(null, "agent-a@shiba.dev")).toBe("agent-a@shiba.dev");
    expect(replyMailbox(null, "")).toBe("");
  });
});
