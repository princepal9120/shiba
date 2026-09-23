/**
 * Worker entry. Serves the dashboard from Static Assets, routes Agent
 * traffic, exposes the retained run registry, and verifies GitHub webhooks.
 * Provider traffic is intercepted at the Sandbox egress boundary — no callback route.
 */
import { ContainerProxy, proxyToSandbox, type Sandbox as SandboxBinding } from "@cloudflare/sandbox";
import { getAgentByName, routeAgentRequest } from "agents/routing";
import { listTokens, verifyToken } from "./agent-tokens.js";
import { OpenCodeAgent } from "./agents/opencode-agent.js";
import { CodingOrchestrator } from "./agents/orchestrator.js";
import { AUTOMATIONS_DO_NAME } from "./automation-runner.js";
import { Automations } from "./automations-do.js";
import { parseAutomationWebhookPath } from "./automations.js";
import { assertLiveCodingModel } from "./coding-model.js";
import { emailApprovalBridgeReady, queueEmailApproval } from "./email-approvals.js";
import { handleInboundEmail } from "./email-handler.js";
import type { Env } from "./env.js";
import { agentCliCatalog } from "./harness/catalog.js";
import { Mailbox, mailboxDirectoryStub, mailboxStub } from "./mailbox-do.js";
import type { PendingApproval } from "./pending-approvals.js";
import type {
  DraftRecord,
  MailboxRecord,
  StoredAttachment,
  StoredEmail,
  ThreadView,
} from "./mailbox-store.js";
import { encodePrincipal, McpGateway, MCP_PRINCIPAL_HEADER } from "./mcp-gateway.js";
import { Sandbox } from "./sandbox.js";
import { InputError, NotFoundError, redactSecrets, verifyGitHubWebhookSignature } from "./security.js";
import { handleSlackInteract } from "./slack-approval.js";
import { handleSlackEvents } from "./slack-events.js";
import { handleSlackEvent } from "./slack-mention.js";
import { ORCHESTRATOR_NAME, handleSlackCommand } from "./slack-routes.js";
import { handleSandboxRoutes } from "./sandbox-routes.js";
import { readSetupStatus } from "./setup-status.js";

export { Automations, CodingOrchestrator, Mailbox, McpGateway, OpenCodeAgent, Sandbox, ContainerProxy };
export { assertLiveCodingModel } from "./coding-model.js";

export function getUserId(request: Request): string | null {
  const email = request.headers.get("CF-Access-Authenticated-User-Email");
  if (!email || email.trim() === "") {
    return null;
  }
  return email.trim();
}

// Only these exact callbacks use signatures instead of an Access identity.
export const SIGNATURE_AUTHENTICATED = [
  "/api/slack/events",
  "/api/slack/command",
  "/api/slack/interact",
  "/api/github/webhook",
];

function isAutomationWebhookPath(pathname: string): boolean {
  return parseAutomationWebhookPath(pathname) !== null;
}

function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

export function isAuthenticated(request: Request, env: Env): boolean {
  const { pathname } = new URL(request.url);
  if (SIGNATURE_AUTHENTICATED.includes(pathname)) return true;
  if (isAutomationWebhookPath(pathname)) return true;
  // `/mcp` runs on bearer tokens, not Access identity — the handler itself
  // verifies before any MCP traffic is served.
  if (isMcpPath(pathname)) return true;
  if (!env.REQUIRE_ACCESS) return true; // opt-out for `wrangler dev`
  return getUserId(request) !== null;
}

function automationsStub(env: Env) {
  return env.Automations.get(env.Automations.idFromName(AUTOMATIONS_DO_NAME));
}

async function handleRuns(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/^\/api\/runs(?:\/[^/]+)?$/.test(url.pathname)) {
    return null;
  }
  if (!isAuthenticated(request, env)) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "GET" && request.method !== "DELETE" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  // Local development shares the same fallback as the dashboard identity endpoint.
  const userId = getUserId(request) ?? "default";
  const stub = await getAgentByName(env.CodingOrchestrator, userId);
  const rewritten = new Request(new URL(url.pathname + url.search, request.url), request);
  return stub.fetch(rewritten);
}

// ---------- Dashboard inbox + memory API (megaplan T11) ----------
//
// Read routes proxy the Mailbox DO namespace (T2 contract): the `__directory__`
// stub lists registered mailboxes, each address stub serves JSON under
// `/internal/mailbox/*`. Bare ids (email, thread, draft) resolve by probing
// the registered mailboxes — the same strategy mcp-email-tools.ts uses.
// Memory routes target the shared "global" Memory DO stub (T8 contract: a
// JSON fetch API mirroring mailbox) and answer 503 until that binding ships.

const MAILBOX_DO_BASE = "https://internal/internal/mailbox";
const MEMORY_DO_BASE = "https://internal/internal/memory";
const INBOX_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

async function mailboxDoJson<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await stub.fetch(`${MAILBOX_DO_BASE}${path}`, init);
  if (!response.ok) {
    const text = (await response.text()).trim();
    const message =
      text === "" ? `Mailbox request failed (HTTP ${response.status})` : text;
    if (response.status === 404) {
      throw new NotFoundError(message);
    }
    if (response.status === 400) {
      throw new InputError(message);
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function mailboxDoJsonOrNull<T>(
  stub: DurableObjectStub,
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    return await mailboxDoJson<T>(stub, path, init);
  } catch (error) {
    if (error instanceof InputError) {
      return null;
    }
    throw error;
  }
}

/** Same contract as MailboxDO's `jsonBody` — a JSON object or a 400. */
async function jsonObjectBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new InputError("Request body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InputError("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

async function registeredMailboxes(env: Env): Promise<MailboxRecord[]> {
  const body = await mailboxDoJson<{ mailboxes?: MailboxRecord[] }>(
    mailboxDirectoryStub(env),
    "/mailboxes",
  );
  return body.mailboxes ?? [];
}

/**
 * Resolve a user-supplied mailbox address to a registered one, or null.
 * Callers must check before `mailboxStub`: `idFromName` instantiates a DO
 * for any string, so probing an unregistered address would create empty
 * mailboxes at unbounded cardinality.
 */
async function resolveRegisteredMailbox(env: Env, address: string): Promise<string | null> {
  const normalized = address.trim().toLowerCase();
  const record = (await registeredMailboxes(env)).find(
    (entry) => entry.address === normalized,
  );
  return record?.address ?? null;
}

/** First non-null probe result across registered mailboxes, like findDraft's. */
async function probeMailboxes<T>(
  env: Env,
  probe: (stub: DurableObjectStub) => Promise<T | null>,
): Promise<{ mailbox: string; value: T } | null> {
  for (const record of await registeredMailboxes(env)) {
    const value = await probe(mailboxStub(env, record.address));
    if (value !== null) {
      return { mailbox: record.address, value };
    }
  }
  return null;
}

/** Merge rows from every registered mailbox, tagging each with its address. */
async function collectMailboxRows<T extends object>(
  env: Env,
  collect: (stub: DurableObjectStub) => Promise<T[]>,
): Promise<Array<T & { mailbox: string }>> {
  const rows: Array<T & { mailbox: string }> = [];
  for (const record of await registeredMailboxes(env)) {
    for (const row of await collect(mailboxStub(env, record.address))) {
      rows.push({ ...row, mailbox: record.address });
    }
  }
  return rows;
}

function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed." }, { status: 405 });
}

function clampedLimit(raw: string | null, fallback: number): number {
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIST_LIMIT) : fallback;
}

/** Cross-mailbox draft lookup — a draft id alone does not name its mailbox. */
async function findInboxDraft(
  env: Env,
  draftId: string,
): Promise<{ mailbox: string; draft: DraftRecord } | null> {
  const located = await probeMailboxes(env, async (stub) =>
    mailboxDoJsonOrNull<{ draft: DraftRecord }>(
      stub,
      `/drafts/${encodeURIComponent(draftId)}`,
    ),
  );
  return located === null ? null : { mailbox: located.mailbox, draft: located.value.draft };
}

/**
 * POST /api/drafts/:id/send — the dashboard's entry into the same approval
 * gate `send_email` uses: lock the draft row, then mint an email_send
 * approval freezing the row the queue CAS returned. Nothing here transmits
 * mail. Lock-then-mint keeps `queued` honest both ways: a failed CAS mints
 * no approval, and the payload is exactly what the row froze — a PATCH
 * racing in ahead of the CAS lands inside the lock, not beside it.
 */
async function queueDraftSend(env: Env, draftId: string): Promise<Response> {
  const located = await findInboxDraft(env, draftId);
  if (located === null) {
    return Response.json(
      { error: `Draft "${draftId}" was not found in any registered mailbox.` },
      { status: 404 },
    );
  }
  const { mailbox, draft } = located;
  if (draft.status !== "draft") {
    return Response.json(
      { error: `Draft "${draftId}" is "${draft.status}" — only drafts in "draft" can be queued for approval.` },
      { status: 409 },
    );
  }
  if (!emailApprovalBridgeReady(env)) {
    return Response.json(
      { error: "Email sending is not configured — the SEND_EMAIL binding is unset, so this draft stays editable." },
      { status: 503 },
    );
  }
  const { draft: queued } = await mailboxDoJson<{ draft: DraftRecord }>(
    mailboxStub(env, mailbox),
    `/drafts/${encodeURIComponent(draftId)}/queue`,
    { method: "POST" },
  );
  let approval: { approval_id: string };
  try {
    approval = await queueEmailApproval(env, {
      kind: "email_send",
      mailbox,
      payload: {
        to_addr: queued.to_addr,
        subject: queued.subject,
        body_text: queued.body_text,
        ...(queued.thread_id !== null ? { thread_id: queued.thread_id } : {}),
        ...(queued.in_reply_to_email_id !== null
          ? { in_reply_to_email_id: queued.in_reply_to_email_id }
          : {}),
        draft_id: queued.id,
      },
    });
  } catch (error) {
    // The queue CAS already landed — without this compensating unqueue the
    // draft strands in `queued` behind an approval that does not exist.
    await mailboxDoJson(mailboxStub(env, mailbox), `/drafts/${encodeURIComponent(draftId)}/unqueue`, {
      method: "POST",
    }).catch((unqueueError) => {
      console.warn(
        `draft unqueue failed after approval mint error ${JSON.stringify({
          draft_id: draftId,
          error: unqueueError instanceof Error ? unqueueError.message : String(unqueueError),
        })}`,
      );
    });
    throw error;
  }
  return Response.json({
    status: "pending_approval",
    kind: "email_send",
    mailbox,
    approval_id: approval.approval_id,
    draft: queued,
  });
}

async function handleInbox(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const emailId = /^\/api\/emails\/([^/]+)$/.exec(pathname)?.[1];
  const emailReadId = /^\/api\/emails\/([^/]+)\/read$/.exec(pathname)?.[1];
  const threadId = /^\/api\/threads\/([^/]+)$/.exec(pathname)?.[1];
  const draftSendId = /^\/api\/drafts\/([^/]+)\/send$/.exec(pathname)?.[1];
  if (
    pathname !== "/api/mailboxes" &&
    pathname !== "/api/emails" &&
    pathname !== "/api/emails-search" &&
    pathname !== "/api/drafts" &&
    emailId === undefined &&
    emailReadId === undefined &&
    threadId === undefined &&
    draftSendId === undefined
  ) {
    return null;
  }
  if (!isAuthenticated(request, env)) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (env.Mailbox === undefined) {
    return Response.json({ error: "Mailboxes are not provisioned yet." }, { status: 503 });
  }
  try {
    if (pathname === "/api/mailboxes") {
      if (request.method !== "GET") return methodNotAllowed();
      return Response.json({ mailboxes: await registeredMailboxes(env) });
    }
    if (pathname === "/api/emails" || pathname === "/api/emails-search") {
      if (request.method !== "GET") return methodNotAllowed();
      const limit = clampedLimit(url.searchParams.get("limit"), INBOX_LIST_LIMIT);
      const query = new URLSearchParams();
      const status = url.searchParams.get("status");
      if (status !== null && status !== "") {
        query.set("status", status);
      }
      query.set("limit", String(limit));
      let path = "/emails";
      if (pathname === "/api/emails-search") {
        const q = url.searchParams.get("q")?.trim() ?? "";
        if (q === "") {
          return Response.json({ error: "Provide a q query parameter." }, { status: 400 });
        }
        query.set("q", q);
        path = "/emails/search";
      }
      const mailbox = url.searchParams.get("mailbox");
      if (mailbox !== null && mailbox !== "") {
        const registered = await resolveRegisteredMailbox(env, mailbox);
        if (registered === null) {
          return Response.json(
            { error: `"${mailbox}" is not a registered mailbox.` },
            { status: 400 },
          );
        }
        const body = await mailboxDoJson<{ emails?: StoredEmail[] }>(
          mailboxStub(env, registered),
          `${path}?${query.toString()}`,
        );
        return Response.json({ mailbox: registered, emails: body.emails ?? [] });
      }
      const emails = await collectMailboxRows<StoredEmail>(env, async (stub) => {
        const body = await mailboxDoJson<{ emails?: StoredEmail[] }>(
          stub,
          `${path}?${query.toString()}`,
        );
        return body.emails ?? [];
      });
      emails.sort((a, b) => b.created_at - a.created_at);
      return Response.json({ emails: emails.slice(0, limit) });
    }
    if (emailId !== undefined) {
      if (request.method !== "GET") return methodNotAllowed();
      const located = await probeMailboxes(env, (stub) =>
        mailboxDoJsonOrNull<{ email: StoredEmail; attachments?: StoredAttachment[] }>(
          stub,
          `/emails/${encodeURIComponent(emailId)}`,
        ),
      );
      if (located === null) {
        return Response.json(
          { error: `Email "${emailId}" was not found in any registered mailbox.` },
          { status: 404 },
        );
      }
      return Response.json({
        mailbox: located.mailbox,
        email: located.value.email,
        // Attachment rows carry internal storage fields (r2_key, content_id);
        // the wire shape is the dashboard's InboxAttachment only.
        attachments: (located.value.attachments ?? []).map((attachment) => ({
          part_id: attachment.part_id,
          filename: attachment.filename,
          mime_type: attachment.mime_type,
          size: attachment.size,
        })),
      });
    }
    if (emailReadId !== undefined) {
      if (request.method !== "POST") return methodNotAllowed();
      // The DO's /read route itself 404s on a missing email — one probe each.
      const located = await probeMailboxes(env, (stub) =>
        mailboxDoJsonOrNull<{ email: StoredEmail; changed: boolean }>(
          stub,
          `/emails/${encodeURIComponent(emailReadId)}/read`,
          { method: "POST" },
        ),
      );
      if (located === null) {
        return Response.json(
          { error: `Email "${emailReadId}" was not found in any registered mailbox.` },
          { status: 404 },
        );
      }
      return Response.json({ mailbox: located.mailbox, ...located.value });
    }
    if (threadId !== undefined) {
      if (request.method !== "GET") return methodNotAllowed();
      const located = await probeMailboxes(env, (stub) =>
        mailboxDoJsonOrNull<{ thread: ThreadView }>(
          stub,
          `/threads/${encodeURIComponent(threadId)}`,
        ),
      );
      if (located === null) {
        return Response.json(
          { error: `Thread "${threadId}" was not found in any registered mailbox.` },
          { status: 404 },
        );
      }
      return Response.json({ mailbox: located.mailbox, thread: located.value.thread });
    }
    if (pathname === "/api/drafts") {
      if (request.method === "GET") {
        const limit = clampedLimit(url.searchParams.get("limit"), INBOX_LIST_LIMIT);
        const query = new URLSearchParams();
        const status = url.searchParams.get("status");
        if (status !== null && status !== "") {
          query.set("status", status);
        }
        query.set("limit", String(limit));
        const mailbox = url.searchParams.get("mailbox");
        if (mailbox !== null && mailbox !== "") {
          const registered = await resolveRegisteredMailbox(env, mailbox);
          if (registered === null) {
            return Response.json(
              { error: `"${mailbox}" is not a registered mailbox.` },
              { status: 400 },
            );
          }
          const body = await mailboxDoJson<{ drafts?: DraftRecord[] }>(
            mailboxStub(env, registered),
            `/drafts?${query.toString()}`,
          );
          return Response.json({ mailbox: registered, drafts: body.drafts ?? [] });
        }
        const drafts = await collectMailboxRows<DraftRecord>(env, async (stub) => {
          const body = await mailboxDoJson<{ drafts?: DraftRecord[] }>(
            stub,
            `/drafts?${query.toString()}`,
          );
          return body.drafts ?? [];
        });
        drafts.sort((a, b) => b.updated_at - a.updated_at);
        return Response.json({ drafts: drafts.slice(0, limit) });
      }
      if (request.method === "POST") {
        const body = await jsonObjectBody(request);
        const mailbox = typeof body.mailbox === "string" ? body.mailbox.trim() : "";
        if (mailbox === "") {
          return Response.json({ error: "Provide a mailbox address." }, { status: 400 });
        }
        const registered = await resolveRegisteredMailbox(env, mailbox);
        if (registered === null) {
          return Response.json(
            { error: `"${mailbox}" is not a registered mailbox.` },
            { status: 400 },
          );
        }
        const created = await mailboxDoJson<{ draft: DraftRecord }>(
          mailboxStub(env, registered),
          "/drafts",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to_addr: body.to_addr,
              subject: body.subject,
              body_text: body.body_text,
              ...(typeof body.thread_id === "string" ? { thread_id: body.thread_id } : {}),
              ...(typeof body.in_reply_to_email_id === "string"
                ? { in_reply_to_email_id: body.in_reply_to_email_id }
                : {}),
            }),
          },
        );
        return Response.json({ mailbox: registered, draft: created.draft }, { status: 201 });
      }
      return methodNotAllowed();
    }
    if (draftSendId !== undefined) {
      if (request.method !== "POST") return methodNotAllowed();
      return await queueDraftSend(env, draftSendId);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

/**
 * Approval pointers live on the orchestrator Durable Object, not the
 * worker: every email approval mints on `"default"` and dashboard-queued
 * runs mint on the caller's instance. Listing fans out to both stubs and
 * merges; resolving probes the caller's DO first, then `"default"` — an
 * `"unknown"` reply means "try the next stub", never a verdict.
 */
async function handleApprovals(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/approvals") {
    return null;
  }
  if (!isAuthenticated(request, env)) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const names = [...new Set([getUserId(request) ?? ORCHESTRATOR_NAME, ORCHESTRATOR_NAME])];
  const stubs = await Promise.all(
    names.map((name) => getAgentByName(env.CodingOrchestrator, name)),
  );
  if (request.method === "GET") {
    const seen = new Map<string, PendingApproval>();
    for (const stub of stubs) {
      const response = await stub.fetch(new Request("https://internal/api/approvals"));
      if (!response.ok) {
        console.warn(`GET /api/approvals probe failed (${response.status})`);
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as { approvals?: PendingApproval[] };
      for (const approval of body.approvals ?? []) {
        seen.set(approval.approvalId, approval);
      }
    }
    const approvals = [...seen.values()].sort((a, b) => a.createdAt - b.createdAt);
    return Response.json({ approvals }, { headers: { "Cache-Control": "no-store" } });
  }
  if (request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await jsonObjectBody(request);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid request body." },
        { status: 400 },
      );
    }
    if (typeof body.threadKey !== "string" || typeof body.approvalId !== "string" || typeof body.approved !== "boolean") {
      return Response.json({ error: "Invalid approval payload." }, { status: 400 });
    }
    const decidedBy = getUserId(request) ?? "default";
    let unknown: Response | null = null;
    let probeFailure: Response | null = null;
    for (const stub of stubs) {
      const response = await stub.fetch(
        new Request("https://internal/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadKey: body.threadKey,
            approvalId: body.approvalId,
            approved: body.approved,
            decidedBy,
            source: "dashboard",
          }),
        }),
      );
      // A stub's transport failure is not a verdict — the pointer may
      // live on the next stub, so keep probing like the GET fan-out.
      if (!response.ok) {
        console.warn(`POST /api/approvals probe failed (${response.status})`);
        probeFailure ??= response;
        continue;
      }
      const result = (await response.json().catch(() => ({}))) as { result?: string };
      if (result.result !== "unknown") {
        return Response.json({ result: result.result });
      }
      unknown = response;
    }
    // No decisive answer: a probe failure means "retry", never the
    // misleading "unknown" a healthy-but-uninvolved stub would imply.
    return probeFailure ?? unknown ?? Response.json({ result: "unknown" });
  }
  return Response.json({ error: "Method not allowed." }, { status: 405 });
}

/** Shared registry stub — cross-agent reads all route through "global" (T8). */
function memoryRegistryStub(env: Env): DurableObjectStub | null {
  if (env.Memory === undefined) {
    return null;
  }
  return env.Memory.get(env.Memory.idFromName("global"));
}

async function handleMemory(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const factId = /^\/api\/memory\/facts\/([^/]+)$/.exec(pathname)?.[1];
  if (pathname !== "/api/memory/facts" && pathname !== "/api/memory/sessions" && factId === undefined) {
    return null;
  }
  if (!isAuthenticated(request, env)) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const stub = memoryRegistryStub(env);
  if (stub === null) {
    return Response.json(
      { error: "Memory is not provisioned yet." },
      { status: 503 },
    );
  }
  if (factId !== undefined) {
    if (request.method !== "DELETE") return methodNotAllowed();
    return stub.fetch(`${MEMORY_DO_BASE}/facts/${encodeURIComponent(factId)}`, {
      method: "DELETE",
    });
  }
  if (request.method !== "GET") return methodNotAllowed();
  const query = new URLSearchParams();
  for (const key of ["agent", "limit"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") {
      query.set(key, value);
    }
  }
  if (pathname === "/api/memory/sessions") {
    return stub.fetch(`${MEMORY_DO_BASE}/sessions?${query.toString()}`);
  }
  // ?q= switches the route from a plain fact listing to recall (T9 contract:
  // hits ranked by score); the Memory DO mirrors mailbox's /emails/search.
  const q = url.searchParams.get("q")?.trim() ?? "";
  const path = q === "" ? `${MEMORY_DO_BASE}/facts` : `${MEMORY_DO_BASE}/facts/search`;
  if (q !== "") {
    query.set("q", q);
  }
  return stub.fetch(`${path}?${query.toString()}`);
}

/**
 * Registered MCP-token principals for `GET /api/agents` — one row per
 * principal name, aggregated across that name's token records. `live`
 * means at least one non-revoked token exists, i.e. the principal can
 * authenticate at `/mcp` right now (the only connection state the
 * worker can observe for request-scoped MCP traffic). `listTokens`
 * fails closed to [] when the KV binding is absent, so the route
 * degrades to the CLI catalog alone.
 */
async function agentPrincipals(env: Env) {
  const byPrincipal = new Map<
    string,
    { principal: string; scopes: string[]; created: number; live: boolean }
  >();
  for (const record of await listTokens(env)) {
    const entry = byPrincipal.get(record.principal) ?? {
      principal: record.principal,
      scopes: [],
      created: record.created,
      live: false,
    };
    entry.created = Math.min(entry.created, record.created);
    for (const scope of record.scopes) {
      if (!entry.scopes.includes(scope)) entry.scopes.push(scope);
    }
    entry.live = entry.live || !record.revoked;
    byPrincipal.set(record.principal, entry);
  }
  return [...byPrincipal.values()].sort((a, b) => a.created - b.created);
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth === null) {
    return null;
  }
  const [scheme, ...rest] = auth.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || rest.length === 0) {
    return null;
  }
  return rest.join(" ");
}

/**
 * `/mcp` (and `/mcp/*`) → bearer auth before any MCP handling: a missing
 * or invalid token is a plain 401 JSON, never an MCP protocol error — the
 * request never reaches the transport. On success the verified principal
 * rides into the DO as the `x-shiba-principal` header, which the tool
 * registry reads per call.
 */
async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isMcpPath(url.pathname)) {
    return null;
  }
  const token = bearerToken(request);
  const record = token === null ? null : await verifyToken(env, token);
  if (!record) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  // Any client-supplied copy must go first — only the worker-verified
  // record may reach the DO under this name.
  const headers = new Headers(request.headers);
  headers.delete(MCP_PRINCIPAL_HEADER);
  // encodePrincipal keeps the JSON ByteString-safe — a non-ASCII
  // principal name would otherwise make Headers.set throw and 500 every
  // call for that token.
  headers.set(MCP_PRINCIPAL_HEADER, encodePrincipal(record));
  return McpGateway.serve("/mcp", { binding: "McpGateway" }).fetch(
    new Request(request, { headers }),
    env,
    ctx,
  );
}

async function handleGitHubWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/github/webhook" || request.method !== "POST") {
    return null;
  }
  const secret = env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!secret) {
    return Response.json(
      { error: "Webhooks are not configured: set the GITHUB_WEBHOOK_SECRET secret." },
      { status: 503 },
    );
  }
  const payload = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const valid = await verifyGitHubWebhookSignature({ secret, payload, signature });
  if (!valid) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  let event: unknown = null;
  try {
    event = JSON.parse(payload);
  } catch {
    return Response.json({ error: "Webhook payload is not valid JSON." }, { status: 400 });
  }
  // Delivery dedupe sits after HMAC verification (an unauthenticated request
  // must never write dedupe keys) and before fan-out. Residual window, stated
  // honestly: if the dedupe key lands but the async fan-out then fails, the
  // event is lost — dedupe narrows duplicates, it does not guarantee zero drops.
  // Fail-open on endpoint errors: a duplicate automation run is recoverable,
  // a dropped webhook is silent loss.
  const deliveryId = request.headers.get("x-github-delivery");
  if (deliveryId) {
    try {
      const dedupeResponse = await automationsStub(env).fetch(
        new Request("https://internal/internal/dedupe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: `gh-delivery:${deliveryId}` }),
        }),
      );
      if (!dedupeResponse.ok) {
        console.error(`github delivery dedupe failed: ${dedupeResponse.status}`);
      } else {
        const body = (await dedupeResponse.json().catch(() => ({}))) as { seen?: boolean };
        if (body.seen === true) {
          return Response.json({ ok: true, deduped: true });
        }
      }
    } catch (error: unknown) {
      console.error(
        `github delivery dedupe failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }
  const githubEvent = request.headers.get("x-github-event") ?? "unknown";
  const action = typeof event === "object" && event !== null
    ? (event as { action?: unknown }).action
    : undefined;
  const waitUntil = ctx?.waitUntil?.bind(ctx);
  if (waitUntil) {
    waitUntil(
      automationsStub(env)
        .fetch(
          new Request("https://internal/internal/github", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: githubEvent, payload: event }),
          }),
        )
        .then((response) => {
          if (!response.ok) {
            console.error(`automation github fan-out failed: ${response.status}`);
          }
        })
        .catch((error: unknown) => {
          console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
        }),
    );
  }
  return Response.json({
    ok: true,
    event: githubEvent,
    action: typeof action === "string" ? action : null,
  });
}

async function handleAutomations(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/automations" || isAutomationWebhookPath(url.pathname)
    || /^\/api\/automations\/[^/]+\/run\/?$/.test(url.pathname)) {
    return automationsStub(env).fetch(request);
  }
  return null;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      automationsStub(env)
        .fetch(new Request("https://internal/internal/tick", { method: "POST" }))
        .then((response) => {
          if (!response.ok) {
            console.error(`automation tick failed: ${response.status}`);
          }
        })
        .catch((error: unknown) => {
          console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
        }),
    );
  },
  // Email Routing delivery — registered-mailbox gate + store, see email-handler.ts.
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleInboundEmail(message, env, ctx);
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!isAuthenticated(request, env)) {
        return Response.json({ error: "Authentication required." }, { status: 401 });
      }
      if (SIGNATURE_AUTHENTICATED.includes(url.pathname) && request.method !== "POST") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      if (url.pathname === "/api/whoami") {
        if (request.method !== "GET") {
          return Response.json({ error: "Method not allowed." }, { status: 405 });
        }
        return Response.json({ agent: getUserId(request) ?? "default" }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (url.pathname === "/api/setup/status") {
        if (request.method !== "GET") {
          return Response.json({ error: "Method not allowed." }, { status: 405 });
        }
        return Response.json(await readSetupStatus(env), {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (url.pathname === "/api/agents") {
        if (request.method !== "GET") {
          return Response.json({ error: "Method not allowed." }, { status: 405 });
        }
        return Response.json(
          { agents: agentCliCatalog(env), principals: await agentPrincipals(env) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const mcpResponse = await handleMcp(
        request,
        env,
        ctx ?? ({ waitUntil: () => {} } as unknown as ExecutionContext),
      );
      if (mcpResponse) {
        return mcpResponse;
      }
      // `/internal/*` paths exist only inside DO stub fetches (Automations
      // tick/dedupe, the Mailbox JSON API under `/internal/mailbox/`) — the
      // worker never serves them to the outside.
      if (url.pathname.startsWith("/internal/")) {
        return Response.json({ error: "Not found." }, { status: 404 });
      }
      const approvalsResponse = await handleApprovals(request, env);
      if (approvalsResponse) {
        return approvalsResponse;
      }
      assertLiveCodingModel(env);
      // proxyToSandbox only needs the Sandbox binding; adapt the type.
      const sandboxEnv = {
        Sandbox: env.Sandbox as unknown as DurableObjectNamespace<SandboxBinding>,
      };
      const sandboxResponse = await proxyToSandbox(request, sandboxEnv);
      if (sandboxResponse) {
        return sandboxResponse;
      }
      const runsResponse = await handleRuns(request, env);
      if (runsResponse) {
        return runsResponse;
      }
      const inboxResponse = await handleInbox(request, env);
      if (inboxResponse) {
        return inboxResponse;
      }
      const memoryResponse = await handleMemory(request, env);
      if (memoryResponse) {
        return memoryResponse;
      }
      const sandboxRouteResponse = await handleSandboxRoutes(request, env);
      if (sandboxRouteResponse) {
        return sandboxRouteResponse;
      }
      const slackEventsResponse = await handleSlackEvents(
        request,
        env,
        ctx ?? { waitUntil: () => {} } as unknown as ExecutionContext,
        {
          dedupe: async (eventId) => {
            const response = await automationsStub(env).fetch(
              new Request("https://internal/internal/dedupe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: `slack-event:${eventId}` }),
              }),
            );
            const body = (await response.json().catch(() => ({}))) as { seen?: boolean };
            return response.ok && body.seen === true;
          },
          onEvent: async (body, eventEnv) => {
            await handleSlackEvent(body, eventEnv);
            try {
              const response = await automationsStub(eventEnv).fetch(
                new Request("https://internal/internal/slack", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                }),
              );
              if (!response.ok) {
                console.error(`automation slack fan-out failed: ${response.status}`);
              }
            } catch (error: unknown) {
              console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
            }
          },
        },
      );
      if (slackEventsResponse) {
        return slackEventsResponse;
      }
      const slackResponse = await handleSlackCommand(request, env);
      if (slackResponse) {
        return slackResponse;
      }
      // Pointer.threadKey names the DO that queued the card (slash = default).
      const slackInteractResponse = await handleSlackInteract(request, env, {
        resolveOrchestrator: (threadKey) => getAgentByName(env.CodingOrchestrator, threadKey || ORCHESTRATOR_NAME),
      }, ctx ? { waitUntil: (promise) => ctx.waitUntil(promise) } : undefined);
      if (slackInteractResponse) {
        return slackInteractResponse;
      }
      const automationsResponse = await handleAutomations(request, env);
      if (automationsResponse) {
        return automationsResponse;
      }
      const webhookResponse = await handleGitHubWebhook(request, env, ctx);
      if (webhookResponse) {
        return webhookResponse;
      }
      if (url.pathname.startsWith("/agents/")) {
        const route = url.pathname.match(/^\/agents\/coding-orchestrator\/([^/]+)(?:\/(.*))?$/);
        if (!route) return Response.json({ error: "Not found." }, { status: 404 });
        let name: string;
        try {
          name = decodeURIComponent(route[1]!);
        } catch {
          return Response.json({ error: "Invalid agent name." }, { status: 400 });
        }
        if (name !== (getUserId(request) ?? "default")) {
          return Response.json({ error: "Forbidden." }, { status: 403 });
        }
        // Slack queue and approval routes are reachable only through verified callbacks.
        if (route[2]?.startsWith("api/") || route[2]?.startsWith("internal/")) {
          return Response.json({ error: "Not found." }, { status: 404 });
        }
      }
      const agentResponse = await routeAgentRequest(request, {
        CodingOrchestrator: env.CodingOrchestrator,
      });
      if (agentResponse) {
        return agentResponse;
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      // The client gets a generic 500; the redacted detail stays in the log.
      console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
      return Response.json({ error: "Internal error." }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
