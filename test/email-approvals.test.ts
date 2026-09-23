import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import {
  emailApprovalBridgeReady,
  executeEmailApproval,
  queueEmailApproval,
} from "../src/email-approvals.js";
import { MAILBOX_DIRECTORY_NAME } from "../src/mailbox-do.js";
import { APPROVAL_TTL_MS, type PendingApproval } from "../src/pending-approvals.js";
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
function agentWithMailbox(opts: {
  failingMailboxPaths?: RegExp;
  messageIds?: Record<string, string[]>;
  /** Opt-in stateful draft rows (id → status) exercising the real CAS seams. */
  drafts?: Record<string, string>;
  /** Opt-in registered addresses the directory's mailboxes list returns. */
  registeredMailboxes?: string[];
  /** Opt-in Slack approval-card target (SLACK_APPROVALS_CHANNEL + token). */
  slackApprovalsChannel?: string;
} = {}) {
  const mailboxCalls: MailboxCall[] = [];
  const send = vi.fn(async (_message: unknown) => ({ status: "ok" }));
  const drafts = opts.drafts;
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
      // Checked before the draft-id match — "release-stale" would
      // otherwise read as a draft id. Stateless age stand-in: frees
      // every locked row the test opted into (`queued`/`sending`).
      if (request.method === "POST" && url.pathname === "/internal/mailbox/drafts/release-stale") {
        const freed: string[] = [];
        if (drafts !== undefined) {
          for (const [id, status] of Object.entries(drafts)) {
            if (status === "queued" || status === "sending") {
              drafts[id] = "draft";
              freed.push(id);
            }
          }
        }
        return Response.json({ drafts: freed.map((id) => ({ id, status: "draft" })) });
      }
      const draftMatch = url.pathname.match(/^\/internal\/mailbox\/drafts\/([^/]+)(?:\/(claim|release|unqueue|sent))?$/);
      if (drafts !== undefined && draftMatch) {
        const id = decodeURIComponent(draftMatch[1]!);
        const seam = draftMatch[2];
        const status = drafts[id];
        if (seam === undefined) {
          return status === undefined
            ? new Response("{}", { status: 404 })
            : Response.json({ draft: { id, status } });
        }
        const from: Record<string, string[]> = {
          claim: ["queued"],
          release: ["sending"],
          unqueue: ["queued"],
          sent: ["queued", "sending"],
        };
        const to: Record<string, string> = {
          claim: "sending",
          release: "draft",
          unqueue: "draft",
          sent: "sent",
        };
        if (status === undefined) {
          return new Response("{}", { status: 404 });
        }
        if (!from[seam]!.includes(status)) {
          return Response.json({ error: `draft is '${status}'` }, { status: 400 });
        }
        drafts[id] = to[seam]!;
        return Response.json({ draft: { id, status: drafts[id] } });
      }
      return new Response("{}", { status: 200 });
    },
  };
  // The directory instance answers registry lookups: any *@shiba.dev
  // address is registered here; anything else is not.
  const directoryStub = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/internal/mailbox/mailboxes") {
        return Response.json({
          mailboxes: (opts.registeredMailboxes ?? []).map((address) => ({
            address, label: null, agent: null, created_at: 0,
          })),
        });
      }
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
    ...(opts.slackApprovalsChannel !== undefined
      ? { SLACK_APPROVALS_CHANNEL: opts.slackApprovalsChannel, SLACK_BOT_TOKEN: "xoxb-test" }
      : {}),
  };
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env,
    state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) { Object.assign(this, { state }); },
  });
  // The resolver hands background work to ctx.waitUntil — capture every
  // dispatch (executor + draft releases) so assertions run only after
  // the frozen payload and any sweeps fully settle.
  const dispatched: Promise<unknown>[] = [];
  Object.assign(instance, {
    ctx: { waitUntil: (pending: Promise<unknown>) => { dispatched.push(pending); } },
  });
  mocks.getAgentByName.mockResolvedValue({ fetch: (request: Request) => instance.onRequest(request) });
  return { instance, env, send, mailboxCalls, settled: async () => { await Promise.all(dispatched); } };
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
  vi.unstubAllGlobals();
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

  it("a rejection whose unqueue fails is freed by the stale-draft re-sweep", async () => {
    // The compensating unqueue is single-shot best-effort — a mailbox
    // failure would strand the row `queued` forever. The stale-draft
    // sweep that same approval touch runs frees locks past their
    // provable lifetime, so the decided approval's draft is recovered.
    const drafts: Record<string, string> = { "draft-1": "queued" };
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox({
      drafts,
      registeredMailboxes: ["agent-a@shiba.dev"],
      failingMailboxPaths: /\/drafts\/draft-1\/unqueue$/,
    });
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    const response = await approve(instance, approval_id, false);
    expect((await response.json() as { result: string }).result).toBe("rejected");
    await settled();
    expect(send).not.toHaveBeenCalled();
    const paths = mailboxCalls.map((call) => `${call.method} ${call.path}`);
    // The single-shot release ran and failed; the sweep recovered the row.
    expect(paths).toContain("POST /internal/mailbox/drafts/draft-1/unqueue");
    expect(paths).toContain("POST /internal/mailbox/drafts/release-stale");
    expect(drafts["draft-1"]).toBe("draft");
  });

  it("a send failure after the claim releases the draft so it can be re-queued", async () => {
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
    // The payload never left — the executor's own claim is released
    // (sending → draft), not marked sent and not left claimed.
    expect(mailboxCalls).toEqual([
      { method: "POST", path: "/internal/mailbox/drafts/draft-1/claim", body: undefined },
      { method: "POST", path: "/internal/mailbox/drafts/draft-1/release", body: undefined },
    ]);
  });

  it("two live approvals on one draft transmit once — the claim dedupes before the wire", async () => {
    // The mint-before-lock ordering in send_email can mint a second
    // approval while the first sits pending: approving both must not
    // put two copies on the wire. The second executor's claim sees the
    // sibling's `sent` mark and satisfies its payload without sending.
    const drafts: Record<string, string> = { "draft-1": "queued" };
    const { instance, env, send, settled } = agentWithMailbox({ drafts });
    const first = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    const second = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    await approve(instance, first.approval_id, true);
    await settled();
    await approve(instance, second.approval_id, true);
    await settled();
    expect(send).toHaveBeenCalledOnce();
    expect(drafts["draft-1"]).toBe("sent");
    // Both records land durable outcomes — the deduped approval is
    // `executed` (its payload went out), not a misleading failure.
    const approvals = instance.state.pendingApprovals ?? [];
    expect(approvals.find((a) => a.approvalId === first.approval_id)?.execution?.status).toBe("executed");
    expect(approvals.find((a) => a.approvalId === second.approval_id)?.execution?.status).toBe("executed");
  });

  it("a claim refusal on an unsent draft fails the execution — never a silent dedupe", async () => {
    // `draft` means the queue lock was reverted — the frozen approval
    // can no longer be honored, so it fails visibly.
    const drafts: Record<string, string> = { "draft-1": "draft" };
    const { instance, env, send, settled } = agentWithMailbox({ drafts });
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    await approve(instance, approval_id, true);
    await settled();
    expect(send).not.toHaveBeenCalled();
    const decided = (instance.state.pendingApprovals ?? []).find(
      (a) => a.approvalId === approval_id,
    );
    expect(decided?.execution?.status).toBe("failed");
    expect(decided?.execution?.error).toContain("draft");
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

  it("an expired email_send releases its queued draft when a resolve sweeps it", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox();
    const expired = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD, draft_id: "draft-stale" },
    });
    // Age the pointer past TTL — the human never clicked it.
    const staleRecord = (instance.state.pendingApprovals ?? []).find(
      (a) => a.approvalId === expired.approval_id,
    )!;
    staleRecord.createdAt = Date.now() - APPROVAL_TTL_MS - 1;
    const live = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD, draft_id: "draft-live" },
    });

    const response = await approve(instance, live.approval_id, true);
    expect((await response.json() as { result: string }).result).toBe("approved");
    await settled();
    // The unrelated resolve swept the expired pointer out of state AND
    // freed its draft — otherwise the row would strand `queued` forever.
    const paths = mailboxCalls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toContain("POST /internal/mailbox/drafts/draft-stale/unqueue");
    expect(paths).toContain("POST /internal/mailbox/drafts/draft-live/sent");
    expect(send).toHaveBeenCalledOnce();
    const remaining = instance.state.pendingApprovals ?? [];
    expect(remaining.some((a) => a.approvalId === expired.approval_id)).toBe(false);
    expect(remaining.find((a) => a.approvalId === live.approval_id)?.status).toBe("approved");
  });

  it("a stale click on an expired email_send pointer frees its draft", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    (instance.state.pendingApprovals ?? [])[0]!.createdAt = Date.now() - APPROVAL_TTL_MS - 1;

    const response = await approve(instance, approval_id, true);
    expect((await response.json() as { result: string }).result).toBe("unknown");
    await settled();
    // The expired pointer resolves nothing — but the draft it owned is
    // released, and nothing ever sent.
    expect(send).not.toHaveBeenCalled();
    expect(mailboxCalls).toEqual([
      { method: "POST", path: "/internal/mailbox/drafts/draft-1/unqueue", body: undefined },
    ]);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
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

  it("refuses a well-formed but unregistered mailbox before touching a stub or the binding", async () => {
    const { env, send, mailboxCalls } = agentWithMailbox();
    await expect(
      executeEmailApproval(env as never, {
        threadKey: "default",
        approvalId: "a-unregistered",
        repoUrl: "x",
        task: "t",
        status: "approved",
        createdAt: 1,
        kind: "email_send",
        payload: { to_addr: "x@y.z", subject: "s", body_text: "b", mailbox: "ghost@example.com" },
      }),
    ).rejects.toThrow(InputError);
    // No stub call, no send — the registry gate ran before any side effect.
    expect(send).not.toHaveBeenCalled();
    expect(mailboxCalls).toHaveLength(0);
  });

  it("executes against the registry's canonical address, not the caller's casing", async () => {
    const { instance, env, send, settled } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "Agent-A@Shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    expect((await approve(instance, approval_id, true)).status).toBe(200);
    await settled();
    expect(send).toHaveBeenCalledWith({
      from: "agent-a@shiba.dev",
      to: "person@example.com",
      subject: "Status update",
      text: "Here is the report.",
    });
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

  it("a poll sweeps an expired email_send: the pointer leaves state and its draft is freed", async () => {
    const { instance, env, send, mailboxCalls, settled } = agentWithMailbox();
    await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    (instance.state.pendingApprovals ?? [])[0]!.createdAt = Date.now() - APPROVAL_TTL_MS - 1;

    const list = await instance.onRequest(new Request("https://internal/api/approvals"));
    const body = (await list.json()) as { approvals: unknown[] };
    expect(body.approvals).toHaveLength(0);
    await settled();
    // The GET hid expired pointers before; now it also prunes them and
    // releases the queued draft — the only release path left once the
    // approval ages out.
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(mailboxCalls).toEqual([
      { method: "POST", path: "/internal/mailbox/drafts/draft-1/unqueue", body: undefined },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("a poll re-sweeps a `queued` draft whose approval is unreachable", async () => {
    // A draft can outlive every path that named it — the mint's
    // compensating unqueue failed after the record never wrote, or the
    // record was dropped. The stale sweep frees the row on the next
    // approval-surface touch even with nothing left to decide.
    const drafts: Record<string, string> = { "draft-orphan": "queued" };
    const { instance, send, mailboxCalls, settled } = agentWithMailbox({
      drafts,
      registeredMailboxes: ["agent-a@shiba.dev"],
    });
    const list = await instance.onRequest(new Request("https://internal/api/approvals"));
    expect(list.status).toBe(200);
    await settled();
    expect(mailboxCalls).toEqual([
      { method: "POST", path: "/internal/mailbox/drafts/release-stale", body: undefined },
    ]);
    expect(drafts["draft-orphan"]).toBe("draft");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("orchestrator restart recovery", () => {
  const approvedRecord = (over: Partial<PendingApproval>): PendingApproval => ({
    threadKey: "default",
    approvalId: "apv-stale",
    repoUrl: "agent-a@shiba.dev",
    task: "email send to person@example.com: Status update",
    status: "approved" as const,
    createdAt: 1,
    decidedBy: "U1",
    decidedAt: 2,
    ...over,
  });

  it("re-drives an approved draft send the lost dispatch never executed", async () => {
    // approved + no execution = the waitUntil died with the DO. The
    // draft still sits `queued`, so the claim CAS proves nothing ever
    // left and the frozen payload sends exactly once.
    const drafts: Record<string, string> = { "draft-1": "queued" };
    const { instance, send, settled } = agentWithMailbox({ drafts });
    instance.state.pendingApprovals = [
      approvedRecord({ kind: "email_send", payload: { ...SEND_PAYLOAD, mailbox: "agent-a@shiba.dev" } }),
    ];
    await instance.onStart();
    await settled();
    expect(send).toHaveBeenCalledOnce();
    expect(drafts["draft-1"]).toBe("sent");
    const decided = (instance.state.pendingApprovals ?? [])[0];
    expect(decided?.execution?.status).toBe("executed");
  });

  it("re-drives an approved email_delete — the delete is idempotent", async () => {
    const { instance, send, mailboxCalls, settled } = agentWithMailbox();
    instance.state.pendingApprovals = [
      approvedRecord({ kind: "email_delete", payload: { ...DELETE_PAYLOAD, mailbox: "agent-a@shiba.dev" } }),
    ];
    await instance.onStart();
    await settled();
    expect(send).not.toHaveBeenCalled();
    expect(mailboxCalls).toEqual([
      { method: "DELETE", path: "/internal/mailbox/emails/email-1", body: undefined },
    ]);
    const decided = (instance.state.pendingApprovals ?? [])[0];
    expect(decided?.execution?.status).toBe("executed");
  });

  it("stamps an approved composed send outcome-unknown — never risks a second copy", async () => {
    // A draftless payload gives the restart nothing to adjudicate: the
    // dead dispatch may already have transmitted, so the record fails
    // visibly instead of re-sending.
    const { instance, send } = agentWithMailbox();
    instance.state.pendingApprovals = [
      approvedRecord({
        kind: "email_send",
        payload: {
          to_addr: "person@example.com",
          subject: "Status update",
          body_text: "Here is the report.",
          mailbox: "agent-a@shiba.dev",
        },
      }),
    ];
    await instance.onStart();
    await flush();
    expect(send).not.toHaveBeenCalled();
    const decided = (instance.state.pendingApprovals ?? [])[0];
    expect(decided?.execution?.status).toBe("failed");
    expect(decided?.execution?.error).toContain("outcome unknown");
  });

  it("a draft left `sending` by the dead attempt is released and fails visibly — no silent resend", async () => {
    // `sending` means the first attempt claimed the row and died
    // mid-flight: transmit status is unknowable, so the recovery frees
    // the dead claim back to `draft` and records a failure rather than
    // deduping or re-sending — otherwise the row sits `sending` forever,
    // unreachable by `unqueue` or any live executor.
    const drafts: Record<string, string> = { "draft-1": "sending" };
    const { instance, send, mailboxCalls, settled } = agentWithMailbox({ drafts });
    instance.state.pendingApprovals = [
      approvedRecord({ kind: "email_send", payload: { ...SEND_PAYLOAD, mailbox: "agent-a@shiba.dev" } }),
    ];
    await instance.onStart();
    await settled();
    expect(send).not.toHaveBeenCalled();
    expect(mailboxCalls.map((call) => `${call.method} ${call.path}`))
      .toContain("POST /internal/mailbox/drafts/draft-1/release");
    expect(drafts["draft-1"]).toBe("draft");
    const decided = (instance.state.pendingApprovals ?? [])[0];
    expect(decided?.execution?.status).toBe("failed");
    expect(decided?.execution?.error).toContain("sending");
    expect(decided?.execution?.error).toContain("outcome unknown");
  });

  it("leaves pending and already-executed approvals alone", async () => {
    const { instance, send, mailboxCalls } = agentWithMailbox();
    instance.state.pendingApprovals = [
      approvedRecord({ kind: "email_delete", status: "pending" }),
      approvedRecord({
        approvalId: "apv-done",
        kind: "email_delete",
        execution: { status: "executed", executedAt: 5 },
      }),
    ];
    await instance.onStart();
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(mailboxCalls).toHaveLength(0);
    const approvals = instance.state.pendingApprovals ?? [];
    expect(approvals[0]?.execution).toBeUndefined();
    expect(approvals[1]?.execution?.status).toBe("executed");
  });
});

describe("email approval Slack card", () => {
  it("posts the card to the configured approvals channel — the plan's second surface", async () => {
    // Email approvals mint with no Slack thread to post into; the
    // configured channel is where their pointer buttons become
    // decidable from Slack, matching the dashboard's card.
    const bodies: Array<{ channel?: string; text?: string; blocks?: unknown[] }> = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string; blocks?: unknown[] });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { env, settled } = agentWithMailbox({ slackApprovalsChannel: "C0APPROVALS" });
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    await settled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://slack.com/api/chat.postMessage");
    const body = bodies[0]!;
    expect(body.channel).toBe("C0APPROVALS");
    const text = JSON.stringify(body.blocks);
    // Spec copy: "Agent X requests email send to Y: subject" — the
    // mailbox stands in for X when the registration carries no agent.
    expect(text).toContain("agent-a@shiba.dev");
    expect(text).toContain("requests email send to person@example.com: Status update");
    expect(text).not.toContain("Send email to");
    // The card carries the live pointer the interact path re-resolves.
    expect(text).toContain(approval_id);
    expect(text).toContain("default");
  });

  it("posts nothing when no approvals channel is configured", async () => {
    // Unset, the dashboard stays the only resolve surface — silently,
    // never a failed fetch.
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { env, settled } = agentWithMailbox();
    await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
