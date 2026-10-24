/**
 * Apply 0.12 outbound ordering for Sandbox SDK 1.0 interceptors.
 * allowedHosts gates first; outboundByHost selects built-in or named handlers.
 */
import type { EgressEnv, OutboundHandlerCtx } from "../egress.js";
import {
  denyUnscopedGitHub,
  forwardAnthropic,
  forwardClaudeSubscription,
  forwardCodexPlan,
  forwardCodexSubscription,
  forwardAntigravityUser,
  forwardCursorSubscription,
  forwardCursorUser,
  forwardGitHubScoped,
  forwardGoogle,
  forwardDeepSeek,
  forwardOpenAI,
  forwardOpenCodeGo,
  forwardXAI,
  forwardXaiUser,
} from "../egress.js";
import type { NamedOutboundHandler, OutboundConfig, OutboundHostRule } from "./outbound-config.js";

const BUILTIN_FORWARDERS: Record<
  string,
  (request: Request, env: EgressEnv, ctx?: OutboundHandlerCtx) => Promise<Response>
> = {
  "generativelanguage.googleapis.com": forwardGoogle,
  "api.anthropic.com": forwardAnthropic,
  "api.openai.com": forwardOpenAI,
  "api.x.ai": forwardXAI,
  "opencode.ai": forwardOpenCodeGo,
  "api.deepseek.com": forwardDeepSeek,
};

function namedHandler(
  name: NamedOutboundHandler,
): (request: Request, env: EgressEnv, ctx?: OutboundHandlerCtx) => Promise<Response> {
  switch (name) {
    case "denyUnscopedGitHub":
      return () => denyUnscopedGitHub();
    case "githubScoped":
      return forwardGitHubScoped;
    case "claudeSubscription":
      return forwardClaudeSubscription;
    case "codexSubscription":
      return forwardCodexSubscription;
    case "codexPlan":
      return forwardCodexPlan;
    case "cursorSubscription":
      return forwardCursorSubscription;
    case "cursorUser":
      return forwardCursorUser;
    case "antigravityUser":
      return forwardAntigravityUser;
    case "xaiUser":
      return forwardXaiUser;
    default:
      return () => Promise.resolve(new Response("Unknown outbound handler.", { status: 500 }));
  }
}

function hostAllowed(config: OutboundConfig, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return config.allowedHosts.some((entry) => entry.toLowerCase() === host);
}

function ruleForHost(config: OutboundConfig, hostname: string): OutboundHostRule | undefined {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  const direct = config.outboundByHost[host];
  if (direct) return direct;
  for (const [pattern, rule] of Object.entries(config.outboundByHost)) {
    if (pattern.includes("*")) {
      const re = new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replaceAll(".", "\\."))
          .join(".*")}$`,
      );
      if (re.test(host)) return rule;
    }
  }
  return undefined;
}

/** Dispatch one intercepted container request through shiba egress handlers. */
export async function dispatchOutboundRequest(
  request: Request,
  env: EgressEnv,
  config: OutboundConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  if (!hostAllowed(config, hostname)) {
    return new Response(`${hostname} is not in the allowed host list for this sandbox.`, { status: 403 });
  }
  const rule = ruleForHost(config, hostname);
  if (!rule) {
    return new Response(`${hostname} has no outbound handler.`, { status: 403 });
  }
  if (rule.kind === "builtin") {
    const forward = BUILTIN_FORWARDERS[rule.host];
    if (!forward) {
      return new Response("Invalid provider destination.", { status: 403 });
    }
    return forward(request, env, config.orgId ? { orgId: config.orgId } : undefined);
  }
  const handler = namedHandler(rule.handler);
  const ctx: OutboundHandlerCtx = {
    ...(config.orgId ? { orgId: config.orgId } : {}),
    ...(rule.params ? { params: rule.params } : {}),
  };
  return handler(request, env, ctx);
}
