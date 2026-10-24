/**
 * Worker-side connection probes for the ModelConfig "test connection" action.
 * Keys never enter containers; responses are redacted before they reach the UI.
 */
import type { Env } from "./env.js";
import { GATEWAY_PROVIDERS } from "./egress.js";
import {
  SERVICE_SECRET_ENV,
  type Connection,
  type ConnectionService,
} from "./model-connections.js";
import { fetchWithBackoff } from "./http-retry.js";
import { redactSecrets } from "./security.js";
import { modelCredentialKeyConfigured } from "./subscription-credentials.js";

export interface ConnectionProbeResult {
  ok: boolean;
  message: string;
  checkedAt: number;
}

/** Gateway slug used for a connection service's BYOK lane. */
const SERVICE_GATEWAY_SLUG: Partial<Record<ConnectionService, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-ai-studio",
  "opencode-go": "opencode-go",
  grok: "grok",
  luan: "opencode-go",
};

function gatewayHostForSlug(slug: string): string | undefined {
  for (const [host, mapped] of Object.entries(GATEWAY_PROVIDERS)) {
    if (mapped === slug) return host;
  }
  return undefined;
}

async function probeGatewayByok(env: Pick<Env, "AI" | "GATEWAY_ID" | "AI_GATEWAY_TOKEN">, connection: Connection): Promise<ConnectionProbeResult> {
  const slug = SERVICE_GATEWAY_SLUG[connection.service];
  const checkedAt = Date.now();
  if (!slug) {
    return {
      ok: false,
      message: `${connection.service} does not use the AI Gateway BYOK lane.`,
      checkedAt,
    };
  }
  try {
    const base = await env.AI.gateway(env.GATEWAY_ID || "default").getUrl(slug);
    const target = new URL(base);
    const host = gatewayHostForSlug(slug);
    if (host) {
      target.pathname = `${target.pathname.replace(/\/+$/, "")}/`;
    }
    const headers = new Headers();
    if (env.AI_GATEWAY_TOKEN) {
      headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`);
    }
    if (connection.credentialRef) {
      headers.set("cf-aig-byok-alias", connection.credentialRef);
    }
    const response = await fetchWithBackoff(target, { method: "HEAD", headers, redirect: "manual" }, {
      attempts: 3,
      baseDelayMs: 200,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: "AI Gateway rejected the request — check AI_GATEWAY_TOKEN and the BYOK credential.",
        checkedAt,
      };
    }
    if (response.status >= 500) {
      return { ok: false, message: "AI Gateway returned a server error.", checkedAt };
    }
    return { ok: true, message: `Gateway "${slug}" responded (${response.status}).`, checkedAt };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, message: redactSecrets(raw) || "Gateway probe failed.", checkedAt };
  }
}

async function probeWorkerSecret(env: Env, connection: Connection): Promise<ConnectionProbeResult> {
  const checkedAt = Date.now();
  const secretName = SERVICE_SECRET_ENV[connection.service];
  if (!secretName) {
    return { ok: false, message: `${connection.service} has no Worker secret probe.`, checkedAt };
  }
  const value = env[secretName as keyof Env];
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: `${secretName} is not configured on this Worker.`, checkedAt };
  }
  if (connection.service === "cursor") {
    try {
      const response = await fetch("https://api2.cursor.sh/health", {
        method: "GET",
        headers: { Authorization: `Bearer ${value}` },
        redirect: "manual",
      });
      if (response.status < 500) {
        return {
          ok: response.status !== 401 && response.status !== 403,
          message:
            response.status === 401 || response.status === 403
              ? "Cursor API rejected the deployment key."
              : `Cursor API responded (${response.status}).`,
          checkedAt,
        };
      }
      return { ok: false, message: `Cursor API returned ${response.status}.`, checkedAt };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      return { ok: false, message: redactSecrets(raw) || "Cursor probe failed.", checkedAt };
    }
  }
  return { ok: true, message: `${secretName} is present.`, checkedAt };
}

async function probeUserSubscription(env: Env, connection: Connection): Promise<ConnectionProbeResult> {
  const checkedAt = Date.now();
  if (!modelCredentialKeyConfigured(env)) {
    return {
      ok: false,
      message: "MODEL_CREDENTIAL_KEY is not configured — per-user ChatGPT subscription storage is unavailable.",
      checkedAt,
    };
  }
  return {
    ok: true,
    message: `${connection.service} uses per-user credentials connected in Settings → Models.`,
    checkedAt,
  };
}

/** Run the appropriate probe for one connection record. */
export async function probeModelConnection(env: Env, connection: Connection): Promise<ConnectionProbeResult> {
  if (connection.authMode === "gateway-byok") {
    return probeGatewayByok(env, connection);
  }
  if (connection.authMode === "user-subscription") {
    return probeUserSubscription(env, connection);
  }
  return probeWorkerSecret(env, connection);
}
