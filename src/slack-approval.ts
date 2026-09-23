/**
 * Block Kit approval with an approver allowlist (PLAN T15).
 *
 * Security model: a valid Slack signature proves the request came from
 * Slack — it proves nothing about who clicked. A Block Kit button in a
 * channel is clickable by every member, so the human behind the click is
 * authorized separately against SLACK_APPROVERS. Unset/empty means nobody
 * can approve from Slack — never "anyone in the channel".
 *
 * The button value is a pointer ({threadKey, approvalId}), not a
 * capability. It is re-resolved server-side and honored only while the
 * approval is still pending (Slack messages never expire; last week's card
 * must not start a run).
 *
 * The handler acks within Slack's 3s window and does the dispatch behind
 * `ctx.waitUntil` when a context is provided.
 */
import type { Env } from "./env.js";
import type { ApprovalKind } from "./pending-approvals.js";
import { redactSecrets } from "./security.js";
import { verifySlackRequest } from "./slack.js";

export const SLACK_INTERACT_PATH = "/api/slack/interact";

export const APPROVE_ACTION_ID = "approve";
export const REJECT_ACTION_ID = "reject";

export interface ApprovalPointer {
  threadKey: string;
  approvalId: string;
}

export interface SlackApprovalEnv {
  SLACK_SIGNING_SECRET?: string;
  SLACK_APPROVERS?: string;
}

export interface SlackApprovalDeps {
  /** Re-resolve the pointer server-side. False = already resolved/replayed. */
  isUnresolved?: (pointer: ApprovalPointer) => Promise<boolean>;
  /** Approve path: resolves the pending call and starts the run. */
  dispatchApprove?: (pointer: ApprovalPointer, userId: string) => Promise<void>;
  /** Reject path: resolves the pending call, starts no container. */
  dispatchReject?: (pointer: ApprovalPointer, userId: string) => Promise<void>;
  /** Ephemeral reply via response_url. Defaults to a best-effort POST. */
  respond?: (responseUrl: string, text: string) => Promise<void>;
  /** Fallback when no dispatch callbacks are injected. */
  orchestratorStub?: { fetch: (request: Request) => Promise<Response> };
  /** Resolve the DO that owns this pointer; mention cards live on thread DOs. */
  resolveOrchestrator?: (threadKey: string) => Promise<{ fetch: (request: Request) => Promise<Response> }>;
}

export interface ExecutionContextLike {
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Parse the SLACK_APPROVERS allowlist: comma-separated Slack user ids.
 * Empty/unset means nobody — never default to "anyone in the channel".
 */
export function parseApproverAllowlist(raw?: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Exact user-id membership. No prefix/channel/role matching. */
export function isApprover(userId: string, allowlist: string[]): boolean {
  return userId !== "" && allowlist.includes(userId);
}

/** Encode a pointer for a button value. Pointer only — no task content. */
export function buildApprovalValue(pointer: ApprovalPointer): string {
  return JSON.stringify({ threadKey: pointer.threadKey, approvalId: pointer.approvalId });
}

/** Decode a button value back to a pointer. Throws on anything else. */
export function parseApprovalValue(value: string): ApprovalPointer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid approval value: not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid approval value: not a pointer.");
  }
  const { threadKey, approvalId } = parsed as Record<string, unknown>;
  if (typeof threadKey !== "string" || threadKey === "" || typeof approvalId !== "string" || approvalId === "") {
    throw new Error("Invalid approval value: pointer requires threadKey and approvalId.");
  }
  return { threadKey, approvalId };
}

export interface ApprovalCardInput extends ApprovalPointer {
  /** Repository URL for run approvals; the sending mailbox for email kinds. */
  repoUrl: string;
  task: string;
  /** PendingApproval kind — "email_send" / "email_delete" get email copy. */
  kind?: ApprovalKind;
  /**
   * Human-readable requester for email kinds (e.g. the mailbox's agent
   * label). Falls back to the mailbox address the record already carries.
   */
  agent?: string;
}

/**
 * Block Kit approval card. Renders the exact structured input that will
 * execute (same discipline as the dashboard approval cards) and two
 * buttons whose values are pointers back to the pending approval.
 * Email kinds render the megaplan's copy — "Agent X requests email send
 * to Y: subject" — where X is the mailbox/agent identity and the
 * record's task already carries the action phrase ("email send to
 * Y: subject" / "email delete of id \"subject\"").
 */
export function buildApprovalBlocks(input: ApprovalCardInput): unknown[] {
  const value = buildApprovalValue({ threadKey: input.threadKey, approvalId: input.approvalId });
  const isEmail = input.kind === "email_send" || input.kind === "email_delete";
  const headline = isEmail
    ? `*${input.agent ?? input.repoUrl}* requests ${input.task}`
    : `*Approval requested*\n*Repo:* ${input.repoUrl}\n*Task:* ${input.task}`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: headline,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `thread \`${input.threadKey}\` · approval \`${input.approvalId}\`` }],
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", action_id: APPROVE_ACTION_ID, value },
        { type: "button", text: { type: "plain_text", text: "Reject" }, style: "danger", action_id: REJECT_ACTION_ID, value },
      ],
    },
  ];
}

interface BlockActionPayload {
  userId: string;
  actionId: string;
  pointer: ApprovalPointer;
  responseUrl: string;
}

function parseBlockActionsPayload(payloadParam: string | null): BlockActionPayload {
  if (!payloadParam) {
    throw new Error("Missing interaction payload.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadParam);
  } catch {
    throw new Error("Interaction payload is not valid JSON.");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Interaction payload has an unexpected shape.");
  }
  const record = payload as Record<string, unknown>;
  const user = record["user"] as { id?: unknown } | undefined;
  const userId = typeof user?.id === "string" ? user.id : "";
  const actions = record["actions"];
  const first = Array.isArray(actions) ? (actions[0] as { action_id?: unknown; value?: unknown } | undefined) : undefined;
  const actionId = typeof first?.action_id === "string" ? first.action_id : "";
  const value = typeof first?.value === "string" ? first.value : "";
  const responseUrl = typeof record["response_url"] === "string" ? (record["response_url"] as string) : "";
  if (userId === "" || actionId === "" || value === "" || responseUrl === "") {
    throw new Error("Interaction payload is missing user, action, value, or response_url.");
  }
  if (!isSlackResponseUrl(responseUrl)) {
    throw new Error("Invalid Slack response URL.");
  }
  return { userId, actionId, pointer: parseApprovalValue(value), responseUrl };
}

export function isSlackResponseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) &&
      url.username === "" && url.password === "" && url.port === "" &&
      url.pathname.startsWith("/actions/");
  } catch {
    return false;
  }
}

async function respondEphemeral(
  responseUrl: string,
  text: string,
  respond?: SlackApprovalDeps["respond"],
): Promise<void> {
  if (respond) {
    await respond(responseUrl, text);
    return;
  }
  // Callback failure must not fail the already-acknowledged interaction.
  try {
    await fetch(responseUrl, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    });
  } catch {
    // Intentionally swallowed — the ack already went out.
  }
}

async function dispatchToOrchestrator(
  stub: { fetch: (request: Request) => Promise<Response> },
  pointer: ApprovalPointer,
  approved: boolean,
  userId: string,
): Promise<void> {
  const response = await stub.fetch(
    new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadKey: pointer.threadKey,
        approvalId: pointer.approvalId,
        approved,
        decidedBy: userId,
        source: "slack",
      }),
    }),
  );
  if (!response.ok) {
    throw new Error(`Approval dispatch failed (${response.status}).`);
  }
}

/**
 * Handle POST /api/slack/interact (block_actions). Returns null for any
 * other path or method so the Worker can fall through. Always acks 200 on
 * a well-formed signed interaction — including refusals — so Slack does
 * not retry; only a bad signature is a 401.
 */
export async function handleSlackInteract(
  request: Request,
  env: Env & SlackApprovalEnv,
  deps: SlackApprovalDeps = {},
  ctx?: ExecutionContextLike,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SLACK_INTERACT_PATH || request.method !== "POST") {
    return null;
  }
  const secret = env.SLACK_SIGNING_SECRET ?? "";
  if (!secret) {
    return Response.json(
      { error: "Slack is not configured: set the SLACK_SIGNING_SECRET secret." },
      { status: 503 },
    );
  }
  // The raw body is the exact signed payload — parse the form after verifying.
  const rawBody = await request.text();
  if (!(await verifySlackRequest(rawBody, request.headers, secret))) {
    return Response.json({ error: "Invalid Slack signature." }, { status: 401 });
  }
  let interaction: BlockActionPayload;
  try {
    interaction = parseBlockActionsPayload(new URLSearchParams(rawBody).get("payload"));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid interaction payload." },
      { status: 400 },
    );
  }

  // The signature authenticates Slack, not the human. Empty list = nobody.
  const approvers = parseApproverAllowlist(env.SLACK_APPROVERS);
  if (!isApprover(interaction.userId, approvers)) {
    const refusal = respondEphemeral(
      interaction.responseUrl,
      "You are not on the approver list.",
      deps.respond,
    );
    if (ctx) {
      ctx.waitUntil(refusal);
    } else {
      await refusal;
    }
    return Response.json({ response_type: "ephemeral", text: "You are not on the approver list." });
  }

  // Re-resolve the pointer server-side; stale/replayed clicks resolve nothing.
  const isUnresolved = deps.isUnresolved ?? (async () => true);
  if (!(await isUnresolved(interaction.pointer))) {
    const stale = respondEphemeral(
      interaction.responseUrl,
      "This approval is already resolved — nothing to do.",
      deps.respond,
    );
    if (ctx) {
      ctx.waitUntil(stale);
    } else {
      await stale;
    }
    return Response.json({ response_type: "ephemeral", text: "This approval is already resolved." });
  }

  const approved = interaction.actionId === APPROVE_ACTION_ID;
  const stubFor = async (pointer: ApprovalPointer) => {
    if (deps.resolveOrchestrator) return deps.resolveOrchestrator(pointer.threadKey);
    if (deps.orchestratorStub) return deps.orchestratorStub;
    throw new Error("Approval dispatch is not configured.");
  };
  const dispatchApprove = deps.dispatchApprove ??
    (async (pointer: ApprovalPointer, userId: string) =>
      dispatchToOrchestrator(await stubFor(pointer), pointer, true, userId));
  const dispatchReject = deps.dispatchReject ??
    (async (pointer: ApprovalPointer, userId: string) =>
      dispatchToOrchestrator(await stubFor(pointer), pointer, false, userId));
  const work = (async () => {
    const dispatch = approved ? dispatchApprove : dispatchReject;
    await dispatch(interaction.pointer, interaction.userId);
  })();
  // The ack already went out, so a dispatch failure must surface to the human
  // in Slack rather than vanish into an unhandled rejection.
  const reported = work.catch((error: unknown) => {
    console.error("Slack approval dispatch failed", redactSecrets(String(error)));
    return respondEphemeral(
      interaction.responseUrl,
      `The ${approved ? "approval" : "rejection"} could not be recorded. Contact the installation administrator.`,
      deps.respond,
    );
  });
  if (ctx) {
    // Ack now (<3s); the dispatch continues in the background.
    ctx.waitUntil(reported);
  } else {
    await reported;
  }
  return new Response("", { status: 200 });
}
