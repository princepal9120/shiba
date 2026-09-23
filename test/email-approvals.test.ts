import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator } from "../src/agents/orchestrator.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import {
  emailApprovalBridgeReady,
  executeEmailApproval,
  queueEmailApproval,
} from "../src/email-approvals.js";
import { emailApprovalRequestLine } from "../src/slack-approval.js";
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
function agentWithMailbox() {
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
      return new Response("{}", { status: 200 });
    },
  };
  const env = {
    Sandbox: {},
    GITHUB_TOKEN: "test-token",
    SEND_EMAIL: { send },
    Mailbox: { idFromName: (address: string) => address, get: () => mailboxStub },
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

  it("rejection leaves the draft unsent: nothing is sent, recorded, or transitioned", async () => {
    const { instance, env, send, mailboxCalls } = agentWithMailbox();
    const { approval_id } = await queueEmailApproval(env as never, {
      kind: "email_send",
      mailbox: "agent-a@shiba.dev",
      payload: { ...SEND_PAYLOAD },
    });
    const response = await approve(instance, approval_id, false);
    expect((await response.json() as { result: string }).result).toBe("rejected");
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(mailboxCalls).toHaveLength(0);
    // The spent pointer cannot later send the payload either.
    const replay = await approve(instance, approval_id, true);
    expect((await replay.json() as { result: string }).result).toBe("unknown");
    await flush();
    expect(send).not.toHaveBeenCalled();
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

describe("email Slack card copy", () => {
  it("reads 'Agent X requests email send to Y: subject'", () => {
    expect(
      emailApprovalRequestLine({
        kind: "email_send",
        agent: "agent-a@shiba.dev",
        toAddr: "person@example.com",
        subject: "Status update",
      }),
    ).toBe("Agent agent-a@shiba.dev requests email send to person@example.com: Status update");
    expect(
      emailApprovalRequestLine({
        kind: "email_delete",
        agent: "agent-a@shiba.dev",
        subject: "Old thread",
      }),
    ).toBe("Agent agent-a@shiba.dev requests email delete of Old thread");
  });
});
