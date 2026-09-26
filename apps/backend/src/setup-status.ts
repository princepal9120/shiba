/**
 * GET /api/setup/status — reports which deploy-time pieces are configured so
 * the onboarding checklist can show live state instead of static steps.
 * Booleans only: never echo secret values or names of unrelated vars.
 */
import type { Env } from "./env.js";

export interface SetupStatus {
  slack: {
    signingSecret: boolean;
    botToken: boolean;
    approvers: number;
    channelRepos: boolean;
  };
  github: { token: boolean; webhookSecret: boolean };
  gateway: { id: string; token: boolean; reachable: "yes" | "unauthorized" | "error" | "unknown" };
  access: { required: boolean };
  models: { orchestrator: string; coding: string; harness: string };
  automations: { enabled: boolean; typeSafe: boolean };
}

/** HEAD the resolved gateway URL: distinguishes reachable/401/other without a body. */
async function probeGateway(env: Env): Promise<SetupStatus["gateway"]["reachable"]> {
  try {
    const url = await env.AI.gateway(env.GATEWAY_ID || "default").getUrl("google-ai-studio");
    const response = await fetch(url, { method: "HEAD" });
    if (response.status === 401 || response.status === 403) return "unauthorized";
    return response.status < 500 ? "yes" : "error";
  } catch {
    return "error";
  }
}

export async function readSetupStatus(env: Env, probe = true): Promise<SetupStatus> {
  const approvers = (env.SLACK_APPROVERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return {
    slack: {
      signingSecret: Boolean(env.SLACK_SIGNING_SECRET),
      botToken: Boolean(env.SLACK_BOT_TOKEN),
      approvers: approvers.length,
      channelRepos: Boolean(env.SLACK_CHANNEL_REPOS),
    },
    github: {
      token: Boolean(env.GITHUB_TOKEN),
      webhookSecret: Boolean(env.GITHUB_WEBHOOK_SECRET),
    },
    gateway: {
      id: env.GATEWAY_ID || "default",
      token: Boolean(env.AI_GATEWAY_TOKEN),
      reachable: probe ? await probeGateway(env) : "unknown",
    },
    access: { required: Boolean(env.REQUIRE_ACCESS || env.ACCESS_AUD) },
    models: {
      orchestrator: env.ORCHESTRATOR_MODEL,
      coding: env.CODING_MODEL,
      harness: env.AGENT_HARNESS ?? "opencode",
    },
    automations: {
      enabled: env.AUTOMATIONS_ENABLED !== "false" && env.AUTOMATIONS_ENABLED !== "0" && env.AUTOMATIONS_ENABLED !== "off",
      typeSafe: Boolean(env.TYPESAFE_API_KEY),
    },
  };
}
