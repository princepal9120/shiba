/**
 * `/api/github/webhook` — HMAC-verified GitHub deliveries, deduped through
 * the Automations DO, then fanned out under waitUntil. Extracted from
 * index.ts.
 */
import { automationsStub } from "./automations-stub.js";
import type { Env } from "./env.js";
import { redactSecrets, verifyGitHubWebhookSignature } from "./security.js";

export async function handleGitHubWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
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
