/**
 * Worker entry. Serves the dashboard from Static Assets, routes Agent
 * traffic, exposes the retained run registry, and verifies GitHub webhooks.
 * Provider traffic is intercepted at the Sandbox egress boundary — no callback route.
 */
import { ContainerProxy, proxyToSandbox, type Sandbox as SandboxBinding } from "@cloudflare/sandbox";
import { getAgentByName, routeAgentRequest } from "agents/routing";
import { OpenCodeAgent } from "./agents/opencode-agent.js";
import { CodingOrchestrator } from "./agents/orchestrator.js";
import { AUTOMATIONS_DO_NAME } from "./automation-runner.js";
import { Automations } from "./automations-do.js";
import { parseAutomationWebhookPath } from "./automations.js";
import { assertLiveCodingModel } from "./coding-model.js";
import { handleInboundEmail } from "./email-handler.js";
import type { Env } from "./env.js";
import { agentCliCatalog } from "./harness/catalog.js";
import { Mailbox } from "./mailbox-do.js";
import { Sandbox } from "./sandbox.js";
import { redactSecrets, verifyGitHubWebhookSignature } from "./security.js";
import { handleSlackInteract } from "./slack-approval.js";
import { handleSlackEvents } from "./slack-events.js";
import { handleSlackEvent } from "./slack-mention.js";
import { ORCHESTRATOR_NAME, handleSlackCommand } from "./slack-routes.js";
import { handleSandboxRoutes } from "./sandbox-routes.js";
import { readSetupStatus } from "./setup-status.js";

export { Automations, CodingOrchestrator, Mailbox, OpenCodeAgent, Sandbox, ContainerProxy };
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



export function isAuthenticated(request: Request, env: Env): boolean {
  const { pathname } = new URL(request.url);
  if (SIGNATURE_AUTHENTICATED.includes(pathname)) return true;
  if (isAutomationWebhookPath(pathname)) return true;
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
          { agents: agentCliCatalog(env) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      // `/internal/*` paths exist only inside DO stub fetches (Automations
      // tick/dedupe, the Mailbox JSON API under `/internal/mailbox/`) — the
      // worker never serves them to the outside.
      if (url.pathname === "/api/approvals" || url.pathname.startsWith("/internal/")) {
        return Response.json({ error: "Not found." }, { status: 404 });
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
