import { describe, expect, it, vi } from "vitest";
import {
  SLACK_INTERACT_PATH,
  buildApprovalBlocks,
  buildApprovalValue,
  handleSlackInteract,
  isApprover,
  parseApprovalValue,
  parseApproverAllowlist,
  type ApprovalPointer,
} from "../src/slack-approval.js";

const SECRET = "test-interact-signing-secret";

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

function slackHeaders(timestamp: string, signature: string): Record<string, string> {
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

function testDeps(overrides: Partial<{ pending: boolean }> = {}) {
  const pending = overrides.pending ?? true;
  return {
    dispatchApprove: vi.fn(async (_pointer: ApprovalPointer, _userId: string): Promise<void> => {}),
    dispatchReject: vi.fn(async (_pointer: ApprovalPointer, _userId: string): Promise<void> => {}),
    respond: vi.fn(async (_responseUrl: string, _text: string): Promise<void> => {}),
    isUnresolved: vi.fn(async (_pointer: ApprovalPointer): Promise<boolean> => pending),
  };
}

function routeEnv(approvers: string | undefined) {
  return {
    SLACK_SIGNING_SECRET: SECRET,
    ...(approvers === undefined ? {} : { SLACK_APPROVERS: approvers }),
    CodingOrchestrator: {},
  } as never;
}

/** Build a signed block_actions request carrying an approve/reject button. */
async function signedInteractRequest(args: {
  userId: string;
  actionId: "approve" | "reject";
  threadKey: string;
  approvalId: string;
  responseUrl?: string;
  secret?: string;
  rawValue?: string;
}): Promise<Request> {
  const value =
    args.rawValue ?? buildApprovalValue({ threadKey: args.threadKey, approvalId: args.approvalId });
  const payload = {
    type: "block_actions",
    user: { id: args.userId },
    actions: [{ action_id: args.actionId, value }],
    response_url: args.responseUrl ?? "https://hooks.slack.com/actions/T/B/XXXX",
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(args.secret ?? SECRET, timestamp, body);
  return new Request(`https://example.com${SLACK_INTERACT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...slackHeaders(timestamp, signature),
    },
    body,
  });
}

describe("parseApproverAllowlist", () => {
  it("splits on commas, trims, and drops empties", () => {
    expect(parseApproverAllowlist("U1, U2 ,,U3")).toEqual(["U1", "U2", "U3"]);
  });

  it("empty or unset allowlist means nobody", () => {
    expect(parseApproverAllowlist("")).toEqual([]);
    expect(parseApproverAllowlist(undefined)).toEqual([]);
  });
});

describe("isApprover", () => {
  it("matches exact Slack user ids only", () => {
    expect(isApprover("U1", ["U1", "U2"])).toBe(true);
    expect(isApprover("U9", ["U1", "U2"])).toBe(false);
    expect(isApprover("U1", [])).toBe(false);
  });
});

describe("approval pointer value", () => {
  it("round-trips threadKey and approvalId", () => {
    const pointer = { threadKey: "slack:T:C:123.456", approvalId: "appr_1" };
    expect(parseApprovalValue(buildApprovalValue(pointer))).toEqual(pointer);
  });

  it("rejects values that are not a pointer (never a capability)", () => {
    expect(() => parseApprovalValue("not-json")).toThrow();
    expect(() => parseApprovalValue(JSON.stringify({ repoUrl: "x" }))).toThrow();
    expect(() => parseApprovalValue(JSON.stringify({ threadKey: "", approvalId: "a" }))).toThrow();
  });
});

describe("buildApprovalBlocks", () => {
  it("renders the exact structured input and pointer-valued buttons", () => {
    const pointer = { threadKey: "slack:T:C:123.456", approvalId: "appr_1" };
    const blocks = buildApprovalBlocks({
      repoUrl: "https://github.com/owner/repo",
      task: "Fix the login bug",
      ...pointer,
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("https://github.com/owner/repo");
    expect(text).toContain("Fix the login bug");
    // Both buttons carry the pointer value, not the decision payload itself.
    const expectedValue = buildApprovalValue(pointer);
    const buttons = (blocks[2] as { elements: { action_id: string; value: string }[] }).elements;
    expect(buttons.map((b) => b.action_id).sort()).toEqual(["approve", "reject"]);
    expect(buttons.map((b) => b.value)).toEqual([expectedValue, expectedValue]);
    expect(parseApprovalValue(buttons[0]!.value)).toEqual(pointer);
  });
});

describe("handleSlackInteract", () => {
  const THREAD = "slack:T1:C1:123.456";

  it("approve by an allowlisted user resolves the pending call (200, dispatch)", async () => {
    const deps = testDeps();
    const request = await signedInteractRequest({
      userId: "U1",
      actionId: "approve",
      threadKey: THREAD,
      approvalId: "appr_1",
    });
    const response = await handleSlackInteract(request, routeEnv("U1,U2"), deps);
    expect(response?.status).toBe(200);
    expect(deps.isUnresolved).toHaveBeenCalledOnce();
    expect(deps.dispatchApprove).toHaveBeenCalledOnce();
    expect(deps.dispatchApprove).toHaveBeenCalledWith(
      { threadKey: THREAD, approvalId: "appr_1" },
      "U1",
    );
    expect(deps.dispatchReject).not.toHaveBeenCalled();
  });

  it("non-allowlisted user is refused and no run starts", async () => {
    const deps = testDeps();
    const request = await signedInteractRequest({
      userId: "U9",
      actionId: "approve",
      threadKey: THREAD,
      approvalId: "appr_1",
    });
    const response = await handleSlackInteract(request, routeEnv("U1,U2"), deps);
    expect(response?.status).toBe(200);
    expect(deps.dispatchApprove).not.toHaveBeenCalled();
    expect(deps.dispatchReject).not.toHaveBeenCalled();
    expect(deps.isUnresolved).not.toHaveBeenCalled();
    expect(deps.respond).toHaveBeenCalledOnce();
    const [, text] = deps.respond.mock.calls[0] as [string, string];
    expect(text).toMatch(/not on the approver list/i);
  });

  it("empty allowlist refuses everyone", async () => {
    const deps = testDeps();
    const request = await signedInteractRequest({
      userId: "U1",
      actionId: "approve",
      threadKey: THREAD,
      approvalId: "appr_1",
    });
    const response = await handleSlackInteract(request, routeEnv(""), deps);
    expect(response?.status).toBe(200);
    expect(deps.dispatchApprove).not.toHaveBeenCalled();
    expect(deps.respond).toHaveBeenCalledOnce();
  });

  it("replayed click on a resolved card starts nothing", async () => {
    const deps = testDeps({ pending: false });
    const request = await signedInteractRequest({
      userId: "U1",
      actionId: "approve",
      threadKey: THREAD,
      approvalId: "appr_1",
    });
    const response = await handleSlackInteract(request, routeEnv("U1"), deps);
    expect(response?.status).toBe(200);
    expect(deps.dispatchApprove).not.toHaveBeenCalled();
    expect(deps.dispatchReject).not.toHaveBeenCalled();
    expect(deps.respond).toHaveBeenCalledOnce();
  });

  it("bad signature returns 401 and dispatches nothing", async () => {
    const deps = testDeps();
    const request = await signedInteractRequest({
      userId: "U1",
      actionId: "approve",
      threadKey: THREAD,
      approvalId: "appr_1",
      secret: "wrong-secret",
    });
    const response = await handleSlackInteract(request, routeEnv("U1"), deps);
    expect(response?.status).toBe(401);
    expect(deps.dispatchApprove).not.toHaveBeenCalled();
    expect(deps.dispatchReject).not.toHaveBeenCalled();
  });

  it("reject starts no container but records the rejection", async () => {
    const deps = testDeps();
    const request = await signedInteractRequest({
      userId: "U1",
      actionId: "reject",
      threadKey: THREAD,
      approvalId: "appr_1",
    });
    const response = await handleSlackInteract(request, routeEnv("U1"), deps);
    expect(response?.status).toBe(200);
    expect(deps.dispatchApprove).not.toHaveBeenCalled();
    expect(deps.dispatchReject).toHaveBeenCalledOnce();
    expect(deps.dispatchReject).toHaveBeenCalledWith(
      { threadKey: THREAD, approvalId: "appr_1" },
      "U1",
    );
  });

  it("orchestratorStub dispatch posts the approval pointer to the DO route", async () => {
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ result: "approved" }), { status: 200 }),
    );
    const request = await signedInteractRequest({
      userId: "U1",
      actionId: "approve",
      threadKey: THREAD,
      approvalId: "appr_1",
    });
    const response = await handleSlackInteract(request, routeEnv("U1"), {
      orchestratorStub: { fetch: fetchMock },
    });
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const forwarded = fetchMock.mock.calls[0]![0] as unknown as Request;
    const payload = (await forwarded.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      threadKey: THREAD,
      approvalId: "appr_1",
      approved: true,
      decidedBy: "U1",
    });
    expect(forwarded.url).toBe("https://internal/api/approvals");
  });

  it("resolveOrchestrator routes the click to the pointer threadKey", async () => {
    const fetchMock = vi.fn(
      async (_req: Request) => new Response(JSON.stringify({ result: "approved" }), { status: 200 }),
    );
    const resolveOrchestrator = vi.fn(async (threadKey: string) => {
      expect(threadKey).toBe(THREAD);
      return { fetch: fetchMock };
    });
    const request = await signedInteractRequest({
      userId: "U1",
      actionId: "approve",
      threadKey: THREAD,
      approvalId: "appr_1",
    });
    const response = await handleSlackInteract(request, routeEnv("U1"), { resolveOrchestrator });
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(resolveOrchestrator).toHaveBeenCalledWith(THREAD));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("orchestratorStub dispatch failure surfaces an ephemeral error, acks 200", async () => {
    const respond = vi.fn(async (_url: string, text: string): Promise<void> => {
      void text;
    });
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 500 }));
    const request = await signedInteractRequest({
      userId: "U1",
      actionId: "approve",
      threadKey: THREAD,
      approvalId: "appr_1",
    });
    const response = await handleSlackInteract(request, routeEnv("U1"), {
      orchestratorStub: { fetch: fetchMock },
      respond,
    });
    expect(response?.status).toBe(200);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(respond.mock.calls[0]![1]).toContain("could not be recorded");
  });

  it("ignores non-interact paths", async () => {
    const request = new Request("https://example.com/api/runs", { method: "GET" });
    const response = await handleSlackInteract(request, routeEnv("U1"), testDeps());
    expect(response).toBeNull();
  });
});
