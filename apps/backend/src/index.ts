/**
 * Worker entry. Serves the dashboard from Static Assets, routes Agent
 * traffic, exposes the retained run registry, and verifies GitHub webhooks.
 * Provider traffic is intercepted at the Sandbox egress boundary — no callback route.
 */
import { ContainerProxy, proxyToSandbox, type Sandbox as SandboxBinding } from "@cloudflare/sandbox";
import { getAgentByName, routeAgentRequest } from "agents/routing";
import { OpenCodeAgent } from "./agents/opencode-agent.js";
import { CodingOrchestrator } from "./agents/orchestrator.js";
import { AUDIT_RETENTION_MS, pruneAuditLog } from "./audit.js";
import { Automations } from "./automations-do.js";
import { automationsStub, seenDelivery } from "./automations-stub.js";
import { assertLiveCodingModel } from "./coding-model.js";
import { handleInboundEmail } from "./email-handler.js";
import type { Env } from "./env.js";
import { Mailbox } from "./mailbox-do.js";
import { MCP_PRINCIPAL_HEADER } from "./mcp-gateway.js";
import { Memory } from "./memory-do.js";
import { Sandbox } from "./sandbox.js";
import { withVerifiedAccessIdentity } from "./access-jwt.js";
import { handleApprovals } from "./approvals-routes.js";
import { handleSubscriptionAuth } from "./auth-routes.js";
import { handleAudit } from "./audit-routes.js";
import { handleAutomations } from "./automations-routes.js";
import { handleGitHubWebhook } from "./github-webhook-routes.js";
import { handleInbox } from "./inbox-routes.js";
import { handleLocalAdapter, isLocalRuntimePath } from "./local-routes.js";
import { LocalDispatch } from "./local-dispatch.js";
import { handleMcp } from "./mcp-routes.js";
import { handleMemory } from "./memory-routes.js";
import { handleOAuth } from "./oauth-mcp.js";
import { handleMeta } from "./meta-routes.js";
import { handleRuns } from "./runs-routes.js";
import { handleUsage } from "./usage-routes.js";
import { handleScreenshot } from "./screenshots-routes.js";
import { handleWebSessions } from "./sessions-routes.js";
import { redactSecrets } from "./security.js";
import { getUserId, isAccessConfigured, isAuthenticated, SIGNATURE_AUTHENTICATED } from "./request-auth.js";
import { handleSlackInteract } from "./slack-approval.js";
import { handleSlackEvents } from "./slack-events.js";
import { handleSlackEvent } from "./slack-mention.js";
import { ORCHESTRATOR_NAME, handleSlackCommand } from "./slack-routes.js";
import { handleDiscordInteractions } from "./discord.js";
import { handleTelegramWebhook } from "./telegram.js";
import { handleTrigger } from "./trigger.js";
import { handleSandboxRoutes } from "./sandbox-routes.js";
import { isPublicRequest } from "./public-routes.js";
import { handleWaitlist } from "./waitlist.js";
import { Waitlist } from "./waitlist-do.js";
import { ModelConfig } from "./model-config-do.js";
import {
  isAuthorizedSessionAgent,
  parseSessionAgentName,
  DEFAULT_SESSION_ID,
  WEB_SESSION_PREFIX,
} from "./web-sessions.js";

export { Automations, CodingOrchestrator, LocalDispatch, Mailbox, Memory, ModelConfig, OpenCodeAgent, Sandbox, ContainerProxy, Waitlist };
export { assertLiveCodingModel } from "./coding-model.js";
// Kept public for consumers that import the auth surface from the entry.
export { getUserId, isAuthenticated, SIGNATURE_AUTHENTICATED } from "./request-auth.js";
export { handleWebSessions } from "./sessions-routes.js";

// Startup assertion (VERIFICATION_PLAN.md G2): `assertLiveCodingModel` already
// enforces the retired-model deny list (see coding-model.ts). Re-running it on
// every request is pure overhead once a request has proven CODING_MODEL live,
// so gate it behind a first-request check — this flag flips to `true` only on
// a non-throwing call, so a still-retired id keeps failing every request.
let codingModelVerified = false;

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
    // Stale-draft sweep: the approvals-poll and restart paths only run it
    // when a human is watching — the cron is the backstop that frees a
    // `sending`-locked draft in an idle system (review finding). Same
    // shared "default" instance the email-kind mints pin to.
    ctx.waitUntil(
      getAgentByName(env.CodingOrchestrator, ORCHESTRATOR_NAME)
        .then((stub) =>
          stub.fetch(new Request("https://internal/internal/sweep-drafts", { method: "POST" })),
        )
        .then((response) => {
          if (!response.ok) {
            console.error(`stale draft sweep failed: ${response.status}`);
          }
        })
        .catch((error: unknown) => {
          console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
        }),
    );
    // Retention: audit_log keeps 90 days — pruned here on the same cron
    // that ticks automations (megaplan T13). Best-effort like the writer:
    // a D1 hiccup warns and retries on the next tick, never blocks it.
    if (env.AGENT_AUDIT !== undefined) {
      ctx.waitUntil(
        pruneAuditLog(env, Date.now() - AUDIT_RETENTION_MS)
          .then((deleted) => {
            if (deleted > 0) {
              console.log(`audit prune deleted ${deleted} row(s) older than 90 days`);
            }
          })
          .catch((error: unknown) => {
            console.warn(
              `audit prune failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            );
          }),
      );
    }
  },
  // Email Routing delivery — registered-mailbox gate + store, see email-handler.ts.
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleInboundEmail(message, env, ctx);
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try {
      request = await withVerifiedAccessIdentity(request, env);
      // MCP_PRINCIPAL_HEADER is minted only by the verified-bearer path in
      // handleMcp — no external caller may set it. Strip at ingress so a
      // future route cannot accidentally trust a client-supplied copy.
      if (request.headers.has(MCP_PRINCIPAL_HEADER)) {
        const headers = new Headers(request.headers);
        headers.delete(MCP_PRINCIPAL_HEADER);
        request = new Request(request, { headers });
      }
      const url = new URL(request.url);
      if (!isPublicRequest(request) && !isAuthenticated(request, env)) {
        return Response.json(
          {
            error: "Authentication required.",
            ...(!isAccessConfigured(env) ? { code: "access_not_configured" } : {}),
          },
          { status: 401 },
        );
      }
      const oauthResponse = await handleOAuth(request, env, getUserId(request));
      if (oauthResponse) return oauthResponse;
      const waitlistResponse = await handleWaitlist(request, env);
      if (waitlistResponse) return waitlistResponse;
      if (SIGNATURE_AUTHENTICATED.includes(url.pathname) && request.method !== "POST") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      const metaResponse = await handleMeta(request, env);
      if (metaResponse) {
        return metaResponse;
      }
      const subscriptionAuthResponse = await handleSubscriptionAuth(request, env);
      if (subscriptionAuthResponse) {
        return subscriptionAuthResponse;
      }
      const mcpResponse = await handleMcp(
        request,
        env,
        ctx ?? ({ waitUntil: () => {} } as unknown as ExecutionContext),
      );
      if (mcpResponse) {
        return mcpResponse;
      }
      // T51: self-authenticated daemon surface — flag + bearer inside.
      if (isLocalRuntimePath(url.pathname)) {
        return handleLocalAdapter(request, env);
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
      if (!codingModelVerified) {
        assertLiveCodingModel(env);
        codingModelVerified = true;
      }
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
      const usageResponse = await handleUsage(request, env);
      if (usageResponse) {
        return usageResponse;
      }
      const screenshotResponse = await handleScreenshot(request, env);
      if (screenshotResponse) {
        return screenshotResponse;
      }
      const webSessionsResponse = await handleWebSessions(request, env);
      if (webSessionsResponse) {
        return webSessionsResponse;
      }
      const inboxResponse = await handleInbox(request, env);
      if (inboxResponse) {
        return inboxResponse;
      }
      const memoryResponse = await handleMemory(request, env);
      if (memoryResponse) {
        return memoryResponse;
      }
      const auditResponse = await handleAudit(request, env);
      if (auditResponse) {
        return auditResponse;
      }
      const sandboxRouteResponse = await handleSandboxRoutes(request, env);
      if (sandboxRouteResponse) {
        return sandboxRouteResponse;
      }
      const chatCtx = ctx ? { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) } : undefined;
      const telegramResponse = await handleTelegramWebhook(request, env, chatCtx, {
        dedupe: (updateId) => seenDelivery(env, `telegram-update:${updateId}`),
      });
      if (telegramResponse) {
        return telegramResponse;
      }
      const discordResponse = await handleDiscordInteractions(request, env, chatCtx);
      if (discordResponse) {
        return discordResponse;
      }
      const slackEventsResponse = await handleSlackEvents(
        request,
        env,
        ctx ?? { waitUntil: () => {} } as unknown as ExecutionContext,
        {
          dedupe: (eventId) => seenDelivery(env, `slack-event:${eventId}`),
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
      const slackResponse = await handleSlackCommand(request, env, {}, ctx);
      if (slackResponse) {
        return slackResponse;
      }
      const triggerResponse = await handleTrigger(request, env);
      if (triggerResponse) {
        return triggerResponse;
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
        const currentUserId = getUserId(request) ?? "default";
        if (!isAuthorizedSessionAgent(name, currentUserId)) {
          return Response.json({ error: "Forbidden." }, { status: 403 });
        }
        if (name.startsWith(WEB_SESSION_PREFIX)) {
          const parsed = parseSessionAgentName(name);
          if (parsed && parsed.sessionId !== DEFAULT_SESSION_ID) {
            const userStub = await getAgentByName(env.CodingOrchestrator, currentUserId);
            const checkRes = await userStub.fetch(
              `https://internal/internal/web-sessions/${encodeURIComponent(parsed.sessionId)}`,
            );
            if (checkRes.status === 404) {
              return Response.json({ error: "Session not found." }, { status: 404 });
            }
            if (!checkRes.ok) {
              return Response.json({ error: "Failed to verify session." }, { status: checkRes.status });
            }
          }
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
      // An `/api/*` URL that survived every handler is an API miss, not a
      // page route — answer JSON instead of the marketing 404 HTML.
      if (url.pathname.startsWith("/api/")) {
        return Response.json({ error: "Not found." }, { status: 404 });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      // The client gets a generic 500; the redacted detail stays in the log.
      console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
      return Response.json({ error: "Internal error." }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
