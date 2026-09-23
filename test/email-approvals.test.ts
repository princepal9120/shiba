import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import {
  emailApprovalBridgeReady,
  executeEmailApproval,
  queueEmailApproval,
} from "../src/email-approvals.js";
import { MAILBOX_DIRECTORY_NAME } from "../src/mailbox-do.js";
import { InputError } from "../src/security.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), getAgentByName: vi.fn(), destroy: vi.fn() }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("agents/routing", () => ({ getAgentByName: mocks.getAgentByName }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => ({ destroy: mocks.destroy }) }));

interface MailboxCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/**
 * An orchestrator instance wired like production: `queueEmailApproval`
 * reaches it through the (mocked) `getAgentByName` stub, and its email
 * executions run against a fake `env.Mailbox` stub + `env.SEND_EMAIL`
 * binding that record every call the frozen payload produces.
 */
function agentWithMailbox(opts: { failingMailboxPaths?: RegExp; messageIds?: Record<string, string[]> } = {}) {
  const mailboxCalls: MailboxCall[] = [];
  const send = vi.fn(async (_message: unknown) => ({ status: "ok" }));
  const mailboxStub = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      mailboxCalls.push({
        method: request.method,
        path: url.pathname,
        // A bodiless POST (e.g. /drafts/:id/sent) yields undefined rather than throwing.
        body: request.method === "POST"
          ? ((await request.json().catch(() => undefined)) as Record<string, unknown> | undefined)
          : undefined,
      });
      if (opts.failingMailboxPaths?.test(url.pathname)) {
        return new Response("fail", { status: 500 });
      }
      const emailMatch = url.pathname.match(/^\/internal\/mailbox\/emails\/([^/]+)$/);
      if (request.method === "GET" && emailMatch) {
        const messageIds = opts.messageIds?.[decodeURIComponent(emailMatch[1]!)] ?? [];
        return new Response(JSON.stringify({ message_ids: messageIds }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  };
  // The directory instance answers registry lookups: any *@shiba.dev
  // address is registered here; anything else is not.
  const directoryStub = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/internal\/mailbox\/mailboxes\/(.+)$/);
      const address = match ? decodeURIComponent(match[1]!).toLowerCase() : "";
      const registered = address.endsWith("@shiba.dev");
      return new Response(
        JSON.stringify({
          mailbox: registered ? { address, label: null, agent: null, created_at: 0 } : null,
          registered,
        }),
        { status: 200 },
      );
    },
  };
  const env = {
    Sandbox: {},
    GITHUB_TOKEN: "test-token",
    SEND_EMAIL: { send },
    Mailbox: {
      idFromName: (address: string) => address.trim().toLowerCase(),
      get: (id: string) => (id === MAILBOX_DIRECTORY_NAME ? directoryStub : mailboxStub),
    },
    CodingOrchestrator: {},
  };
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env,
    state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) { Object.assign(this, { state }); },
  });
  // The resolver hands the executor promise to ctx.waitUntil — capture it
  // so assertions run only after the frozen payload fully executes.
  let dispatched: Promise<unknown> | undefined;
  Object.assign(instance, {
    ctx: { waitUntil: (pending: Promise<unknown>) => { dispatched = pending; } },
  });
  mocks.getAgentByName.mockResolvedValue({ fetch: (request: Request) => instance.onRequest(request) });
  return { instance, env, send, mailboxCalls, settled: async () => dispatched };
}

function approve(instance: CodingOrchestrator, approvalId: string, approved: boolean) {
  return instance.onRequest(
    new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved, decidedBy: "U1" }),
    }),
  );
}

/** Let the fire-and-forget executor settle (no ctx.waitUntil in tests). */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const SEND_PAYLOAD = {
  to_addr: "person@example.com",
  subject: "Status update",
  body_text: "Here is the report.",
  thread_id: "thread-1",
  draft_id: "draft-1",
};

const DELETE_PAYLOAD = { email_id: "email-1", subject: "Old thread", from_addr: "peer@example.com" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
});

describe("queueEmailApproval", () => {
  it("stores the frozen payload + mailbox on a pending approval record", async () => {
    const { instance, env } = agentWithMailbox();
    const result = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "Agent-A@Shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    expect(result.approval_id).toBeTruthy();
    // The queue reached the shared "default" orchestrator via the DO stub.
    expect(mocks.getAgentByName).toHaveBeenCalledWith(env.CodingOrchestrator, "default");
    const approvals = instance.state.pendingApprovals ?? [];
    expect(approvals).toHaveLength(1);
    const record = approvals[0]!;
    expect(record).toMatchObject({
      threadKey: "default",
      approvalId: result.approval_id,
      status: "pending",
      kind: "email_send",
      repoUrl: "Agent-A@Shiba.dev",
    });
    // The frozen payload is authoritative: the executor reads only this.
    expect(record.payload).toEqual({ ...SEND_PAYLOAD, mailbox: "Agent-A@Shiba.dev" });
    expect(record.task).toContain("person@example.com");
    expect(record.task).toContain("Status update");
    expect(instance.state.runs).toEqual([]); // no run exists before approval
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("stores an email_delete approval with its display summary", async () => {
    const { instance, env } = agentWithMailbox();
    const result = await queueEmailApproval(env as never, {
      kind: "email_delete",
      mailbox: "agent-a@shiba.dev",
      payload: { ...DELETE_PAYLOAD },
    });
    const record = (instance.state.pendingApprovals ?? [])[0]!;
    expect(record.kind).toBe("email_delete");
    expect(record.payload).toEqual({ ...DELETE_PAYLOAD, mailbox: "agent-a@shiba.dev" });
    expect(record.task).toContain("email-1");
    expect(record.task).toContain("Old thread");
    expect(result.approval_id).toBe(record.approvalId);
  });

  it("rejects malformed queues: bad mailbox, missing payload fields, non-run kind", async () => {
    const { instance } = agentWithMailbox();
    const post = (body: unknown) =>
      instance.onRequest(
        new Request("https://internal/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await post({ kind: "email_send", mailbox: "not-an-email", payload: { ...SEND_PAYLOAD } })).status).toBe(400);
    expect((await post({ kind: "email_send", mailbox: "a@shiba.dev", payload: { to_addr: "x@y.z" } })).status).toBe(400);
    expect((await post({ kind: "email_send", mailbox: "a@shiba.dev", payload: "nope" })).status).toBe(400);
    expect((await post({ kind: "email_delete", mailbox: "a@shiba.dev", payload: { subject: "s" } })).status).toBe(400);
    expect((await post({ kind: "bogus", mailbox: "a@shiba.dev", payload: {} })).status).toBe(400);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("rejects an unregistered mailbox at intake — the registry invariant the MCP path enforces", async () => {
    const { instance } = agentWithMailbox();
    const post = (body: unknown) =>
      instance.onRequest(
        new Request("https://internal/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    // Well-formed everywhere except registration — the surface must not
    // queue an approval From an address the registry does not own.
    expect(
      (await post({ kind: "email_send", mailbox: "ghost@example.com", payload: { ...SEND_PAYLOAD } })).status,
    ).toBe(400);
    expect(
      (await post({ kind: "email_delete", mailbox: "ghost@example.com", payload: { ...DELETE_PAYLOAD } })).status,
    ).toBe(400);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("rejects a malformed to_addr at intake instead of failing at the binding post-approval", async () => {
    const { instance } = agentWithMailbox();
    const post = (body: unknown) =>
      instance.onRequest(
        new Request("https://internal/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect(
      (
        await post({
          kind: "email_send",
          mailbox: "agent-a@shiba.dev",
          payload: { ...SEND_PAYLOAD, to_addr: "not-an-address" },
        })
      ).status,
    ).toBe(400);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });
});

describe("email approval execution", () => {
  it("approve sends the frozen payload once, records the outbound copy, and marks the draft sent", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    const response = await approve(instance, approval_id, true);
    expect((await response.json() as { result: string }).result).toBe("approved");
    await settled();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      from: "agent-a@shiba.dev",
      to: "person@example.com",
      subject: "Status update",
      text: "Here is the report.",
    });
    const paths = mailboxCalls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toContain("POST /internal/mailbox/emails");
    expect(paths).toContain("POST /internal/mailbox/drafts/draft-1/sent");
    const outbound = mailboxCalls.find((call) => call.path === "/internal/mailbox/emails");
    expect(outbound?.body).toMatchObject({
      direction: "outbound",
      from_addr: "agent-a@shiba.dev",
      to_addr: "person@example.com",
      subject: "Status update",
      body_text: "Here is the report.",
      status: "sent",
      thread_id: "thread-1",
    });
    // No coding run was created — email approvals bypass every run gate.
    expect(instance.state.runs).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
    // The runless execution's outcome lands on the approval record —
    // durable state in place of a run's terminal status.
    const decided = (instance.state.pendingApprovals ?? []).find(
      (a) => a.approvalId === approval_id,
    );
    expect(decided?.status).toBe("approved");
    expect(decided?.execution?.status).toBe("executed");
    expect(decided?.execution?.executedAt).toBeGreaterThan(0);
  });

  it("approved replies send In-Reply-To/References from the parent's stored Message-ID", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox({
      messageIds: { "parent-1": ["<original-msg@example.com>"] },
    });
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: {
        to_addr: "peer@example.com",
        subject: "Re: Status update",
        body_text: "Thanks — received.",
        thread_id: "thread-1",
        in_reply_to_email_id: "parent-1",
      },
    });
    await approve(instance, approval_id, true);
    await settled();
    // The frozen internal id resolved to the wire Message-ID, so the
    // approved reply threads in the recipient's mail client.
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      from: "agent-a@shiba.dev",
      to: "peer@example.com",
      subject: "Re: Status update",
      text: "Thanks — received.",
      headers: {
        "In-Reply-To": "<original-msg@example.com>",
        References: "<original-msg@example.com>",
      },
    });
    // The stored outbound copy records the same link — the mailbox was
    // asked for the parent's RFC822 id before the send went out.
    const outbound = mailboxCalls.find((call) => call.path === "/internal/mailbox/emails" && call.method === "POST");
    expect(outbound?.body).toMatchObject({ in_reply_to: "<original-msg@example.com>" });
    expect(mailboxCalls.some((call) => call.method === "GET" && call.path === "/internal/mailbox/emails/parent-1")).toBe(true);
  });

  it("a reply whose parent has no stored Message-ID sends unthreaded rather than vetoing the send", async () => {
    const { instance, env, send, settled } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: {
        to_addr: "peer@example.com",
        subject: "Re: Status update",
        body_text: "Thanks — received.",
        in_reply_to_email_id: "parent-gone",
      },
    });
    await approve(instance, approval_id, true);
    await settled();
    expect(send).toHaveBeenCalledWith({
      from: "agent-a@shiba.dev",
      to: "peer@example.com",
      subject: "Re: Status update",
      text: "Thanks — received.",
    });
  });

  it("a failed execution writes a durable outcome onto the approval record", async () => {
    const { instance, env, send, settled } = agentWithMailbox();
    send.mockRejectedValue(new Error("smtp down"));
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    expect((await approve(instance, approval_id, true)).status).toBe(200);
    await settled();
    // `approved` + no execution state would read as "went out fine" —
    // the failure is durable on the record, not only a log line.
    const decided = (instance.state.pendingApprovals ?? []).find(
      (a) => a.approvalId === approval_id,
    );
    expect(decided?.status).toBe("approved");
    expect(decided?.execution?.status).toBe("failed");
    expect(decided?.execution?.error).toContain("smtp down");
  });

  it("resolve is replay-guarded: a second approve executes nothing", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    expect((await approve(instance, approval_id, true)).status).toBe(200);
    await settled();
    const callsAfterFirst = mailboxCalls.length;
    expect(send).toHaveBeenCalledOnce();
    const replay = await approve(instance, approval_id, true);
    expect((await replay.json() as { result: string }).result).toBe("unknown");
    await settled();
    await flush();
    expect(send).toHaveBeenCalledOnce();
    expect(mailboxCalls).toHaveLength(callsAfterFirst);
  });

  it("rejection releases the queued draft back to 'draft' and sends nothing", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    const response = await approve(instance, approval_id, false);
    expect((await response.json() as { result: string }).result).toBe("rejected");
    await settled();
    expect(send).not.toHaveBeenCalled();
    // The compensating unqueue frees the row — otherwise the draft strands
    // `queued` behind a pointer that can never be re-resolved.
    expect(mailboxCalls).toEqual([
      { method: "POST", path: "/internal/mailbox/drafts/draft-1/unqueue", body: undefined },
    ]);
    // The spent pointer cannot later send the payload either.
    const replay = await approve(instance, approval_id, true);
    expect((await replay.json() as { result: string }).result).toBe("unknown");
    await settled();
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(mailboxCalls).toHaveLength(1);
  });

  it("rejection of an email_delete does not touch the mailbox", async () => {
    const { instance, env, send, mailboxCalls } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_delete",
      mailbox: "agent-a@shiba.dev",
      payload: { ...DELETE_PAYLOAD },
    });
    const response = await approve(instance, approval_id, false);
    expect((await response.json() as { result: string }).result).toBe("rejected");
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(mailboxCalls).toHaveLength(0);
  });

  it("a send failure before transmission unqueues the draft so it can be re-queued", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox();
    send.mockRejectedValue(new Error("smtp down"));
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    const response = await approve(instance, approval_id, true);
    expect((await response.json() as { result: string }).result).toBe("approved");
    await settled();
    // The payload never left — the draft goes back to editable `draft`,
    // not to `sent`.
    expect(mailboxCalls).toEqual([
      { method: "POST", path: "/internal/mailbox/drafts/draft-1/unqueue", body: undefined },
    ]);
  });

  it("a post-transmission failure reconciles the draft to 'sent', never re-queues it", async () => {
    // The outbound copy insert fails after the mail already went out —
    // the truth is 'sent', and re-queueing would double-send.
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox({
      failingMailboxPaths: /^\/internal\/mailbox\/emails$/,
    });
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    const response = await approve(instance, approval_id, true);
    expect((await response.json() as { result: string }).result).toBe("approved");
    await settled();
    expect(send).toHaveBeenCalledOnce();
    const paths = mailboxCalls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toContain("POST /internal/mailbox/emails");
    expect(paths).toContain("POST /internal/mailbox/drafts/draft-1/sent");
    expect(paths).not.toContain("POST /internal/mailbox/drafts/draft-1/unqueue");
  });

  it("approve on email_delete issues the mailbox DELETE exactly once", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_delete",
      mailbox: "agent-a@shiba.dev",
      payload: { ...DELETE_PAYLOAD },
    });
    const response = await approve(instance, approval_id, true);
    expect((await response.json() as { result: string }).result).toBe("approved");
    await settled();
    await flush();
    expect(mailboxCalls).toEqual([
      { method: "DELETE", path: "/internal/mailbox/emails/email-1", body: undefined },
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(instance.state.runs).toEqual([]);
  });
});

describe("executeEmailApproval guardrails", () => {
  it("refuses payloads that do not name a valid mailbox or their required fields", async () => {
    const { env } = agentWithMailbox();
    await expect(
      executeEmailApproval(env as never, {
        threadKey: "default",
        approvalId: "a1",
        repoUrl: "x",
        task: "t",
        status: "approved",
        createdAt: 1,
        kind: "email_send",
        payload: { to_addr: "x@y.z", subject: "s", body_text: "b", mailbox: "bad" },
      }),
    ).rejects.toThrow(InputError);
    await expect(
      executeEmailApproval(env as never, {
        threadKey: "default",
        approvalId: "a2",
        repoUrl: "x",
        task: "t",
        status: "approved",
        createdAt: 1,
        kind: "email_delete",
        payload: { mailbox: "agent-a@shiba.dev", subject: "no email_id" },
      }),
    ).rejects.toThrow(InputError);
    await expect(
      executeEmailApproval(env as never, {
        threadKey: "default",
        approvalId: "a3",
        repoUrl: "x",
        task: "t",
        status: "approved",
        createdAt: 1,
        kind: "email_send",
      }),
    ).rejects.toThrow(/no frozen payload/i);
  });

  it("throws when SEND_EMAIL is unset rather than recording an unsent copy", async () => {
    const { env } = agentWithMailbox();
    delete (env as { SEND_EMAIL?: unknown }).SEND_EMAIL;
    await expect(
      executeEmailApproval(env as never, {
        threadKey: "default",
        approvalId: "a4",
        repoUrl: "x",
        task: "t",
        status: "approved",
        createdAt: 1,
        kind: "email_send",
        payload: { ...SEND_PAYLOAD, mailbox: "agent-a@shiba.dev" },
      }),
    ).rejects.toThrow(/SEND_EMAIL/);
  });
});

describe("emailApprovalBridgeReady", () => {
  it("is false without a send_email binding and true with one", () => {
    const { env } = agentWithMailbox();
    expect(emailApprovalBridgeReady(env as never)).toBe(true);
    delete (env as { SEND_EMAIL?: unknown }).SEND_EMAIL;
    expect(emailApprovalBridgeReady(env as never)).toBe(false);
  });
});

describe("GET /api/approvals", () => {
  it("lists only live pending pointers — decided records leave the list", async () => {
    const { instance, env, settled } = agentWithMailbox();
    const first = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    const second = await queueEmailApproval(env as never, {
      kind: "email_delete",
      mailbox: "agent-a@shiba.dev",
      payload: { ...DELETE_PAYLOAD },
    });
    const list = await instance.onRequest(new Request("https://internal/api/approvals"));
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      approvals: Array<{ approvalId: string; kind?: string; task: string; status: string }>;
    };
    expect(body.approvals.map((a) => a.approvalId).sort()).toEqual(
      [first.approval_id, second.approval_id].sort(),
    );
    expect(body.approvals.every((a) => a.status === "pending")).toBe(true);
    const resolved = await approve(instance, first.approval_id, false);
    expect((await resolved.json() as { result: string }).result).toBe("rejected");
    await settled();
    const after = await instance.onRequest(new Request("https://internal/api/approvals"));
    const remaining = (await after.json()) as { approvals: Array<{ approvalId: string }> };
    expect(remaining.approvals.map((a) => a.approvalId)).toEqual([second.approval_id]);
  });
});
