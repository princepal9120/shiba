/**
 * Slack Events API endpoint (PLAN T12).
 *
 * Slack requires every event delivery to be acked within 3 seconds or it
 * retries — including after a *late* 200, so one mention would otherwise
 * become two runs. This handler therefore:
 *
 * 1. Verifies the v0 HMAC signature (`src/slack.ts`) before doing anything.
 * 2. Answers `url_verification` handshakes synchronously with the challenge.
 * 3. Acks `event_callback` deliveries with an immediate 200 and defers all
 *    real work (repo resolution, bursts, orchestrator dispatch — T13/T14)
 *    to `ctx.waitUntil`, keeping the ack well under Slack's 3s budget.
 * 4. Dedupes on `event_id`: Slack stops after ~3 attempts over ~30 min, so
 *    a bounded in-memory ring of seen ids makes retries a no-op.
 *
 * NOTE (T12a): Slack's servers cannot complete a Cloudflare Access login,
 * so the Access application needs a Bypass policy for `/api/slack/*`
 * (and `/api/github/webhook`). Signature verification below is the code
 * half; the bypass policy is the other half — both or it silently fails.
 */

import type { Env } from "./env.js";
import { verifySlackRequest } from "./slack.js";

export const SLACK_EVENTS_PATH = "/api/slack/events";

/**
 * Upper bound on remembered event ids. Slack retries at most ~3 times over
 * ~30 minutes, so a 1000-entry ring covers every in-flight retry storm with
 * room to spare while keeping DO/Worker memory constant.
 */
export const MAX_SEEN_EVENT_IDS = 1000;

const seenEventIds = new Set<string>();
const seenOrder: string[] = [];

/** True when this `event_id` was already acked (a Slack retry). */
export function hasSeenSlackEvent(eventId: string): boolean {
  return seenEventIds.has(eventId);
}

/** Record an `event_id` as acked, evicting the oldest once bounded. */
export function recordSeenSlackEvent(eventId: string): void {
  if (seenEventIds.has(eventId)) {
    return;
  }
  seenEventIds.add(eventId);
  seenOrder.push(eventId);
  while (seenOrder.length > MAX_SEEN_EVENT_IDS) {
    const oldest = seenOrder.shift();
    if (oldest !== undefined) {
      seenEventIds.delete(oldest);
    }
  }
}

/** Test hook: reset the dedupe ring between tests. */
export function clearSeenSlackEvents(): void {
  seenEventIds.clear();
  seenOrder.length = 0;
}

export interface SlackEventsDeps {
  /**
   * Background work for one acked event (T13/T14 fill this in: burst
   * grouping, repo resolution, orchestrator dispatch). Defaults to a
   * no-op so T12 ships the ack + dedupe contract on its own.
   */
  onEvent?: (body: SlackEventCallbackBody, env: Env) => Promise<void>;
  /**
   * Durable check-and-record for `event_id` (Automations DO). Returns true
   * when the id was already recorded. The in-memory ring stays as the
   * same-isolate fast path; this covers retries that land elsewhere.
   */
  dedupe?: (eventId: string) => Promise<boolean>;
}

export interface SlackEventCallbackBody {
  type: "event_callback";
  event_id: string;
  event?: Record<string, unknown> & { type?: string };
  [key: string]: unknown;
}

function isEventCallbackBody(value: unknown): value is SlackEventCallbackBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; event_id?: unknown };
  return candidate.type === "event_callback" && typeof candidate.event_id === "string";
}

/**
 * Handle POST /api/slack/events. Returns null for any other path or
 * method so the Worker can fall through to the remaining routes.
 *
 * The response is always sent synchronously and fast; event processing
 * never blocks the ack — it runs in `ctx.waitUntil`.
 */
export async function handleSlackEvents(
  request: Request,
  env: Env & { SLACK_SIGNING_SECRET?: string },
  ctx: ExecutionContext,
  deps: SlackEventsDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SLACK_EVENTS_PATH || request.method !== "POST") {
    return null;
  }
  const secret = env.SLACK_SIGNING_SECRET ?? "";
  if (!secret) {
    return Response.json(
      { error: "Slack is not configured: set the SLACK_SIGNING_SECRET secret." },
      { status: 503 },
    );
  }
  // The raw body is the exact signed payload — parse the JSON after verifying.
  const rawBody = await request.text();
  if (!(await verifySlackRequest(rawBody, request.headers, secret))) {
    return Response.json({ error: "Invalid Slack signature." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Slack event payload is not valid JSON." }, { status: 400 });
  }
  if (typeof body === "object" && body !== null && (body as { type?: unknown }).type === "url_verification") {
    const challenge = (body as { challenge?: unknown }).challenge;
    if (typeof challenge !== "string" || challenge === "") {
      return Response.json({ error: "url_verification payload is missing its challenge." }, { status: 400 });
    }
    return Response.json({ challenge });
  }
  if (!isEventCallbackBody(body)) {
    // Unknown or unhandled envelope (e.g. endpoint verification retries):
    // ack so Slack does not retry, schedule nothing.
    return new Response("", { status: 200 });
  }
  // One mention, one run. event_id is the idempotency key. The in-memory
  // ring answers same-isolate retries for free; the durable dep covers
  // retries that land on another isolate.
  if (hasSeenSlackEvent(body.event_id)) {
    return new Response("", { status: 200 });
  }
  if (deps.dedupe) {
    try {
      if (await deps.dedupe(body.event_id)) {
        recordSeenSlackEvent(body.event_id);
        return new Response("", { status: 200 });
      }
    } catch {
      // Dedupe backend down: ack anyway — a duplicate beats a lost event.
    }
  }
  recordSeenSlackEvent(body.event_id);
  const onEvent = deps.onEvent ?? (async () => {});
  ctx.waitUntil(onEvent(body, env));
  return new Response("", { status: 200 });
}
