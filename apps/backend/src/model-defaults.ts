/**
 * Default harness + model pairs for a registered model connection service.
 * Used when exactly one ready connection exists so every role can route
 * without hand-written ROLE_MODEL_MAP pins.
 */
import { HARNESS_DEFAULT_MODELS } from "./harness/index.js";
import {
  compatibleHarnesses,
  providerOfService,
  type Connection,
  type ConnectionService,
} from "./model-connections.js";
import type { ModelConfigSnapshot } from "./model-policy.js";

const SERVICE_DEFAULT_CODING: Record<ConnectionService, { harness: string; model: string }> = {
  anthropic: { harness: "claude-code", model: HARNESS_DEFAULT_MODELS["claude-code"] as string },
  openai: { harness: "codex", model: HARNESS_DEFAULT_MODELS.codex as string },
  "openai-subscription": {
    harness: "codex-subscription",
    model: HARNESS_DEFAULT_MODELS["codex-subscription"] as string,
  },
  google: { harness: "opencode", model: HARNESS_DEFAULT_MODELS.opencode as string },
  grok: { harness: "grok", model: HARNESS_DEFAULT_MODELS.grok as string },
  "opencode-go": { harness: "opencode", model: "opencode-go/deepseek-v3.2" },
  luan: { harness: "opencode", model: "opencode-go/deepseek-v3.2" },
  cursor: { harness: "codex", model: HARNESS_DEFAULT_MODELS.codex as string },
  acp: { harness: "acp", model: HARNESS_DEFAULT_MODELS.acp as string },
};

/** The sole ready connection when the deployment has exactly one; otherwise null. */
export function soleReadyConnection(snapshot: ModelConfigSnapshot): Connection | null {
  const ready = snapshot.connections.filter((c) => c.status === "ready");
  return ready.length === 1 ? (ready[0] ?? null) : null;
}

/**
 * Harness + model that match a connection's service namespace. Returns null
 * when the service cannot drive a sandbox coding harness.
 */
export function defaultCodingFromConnection(connection: Connection): { harness: string; model: string } | null {
  const pair = SERVICE_DEFAULT_CODING[connection.service];
  if (pair === undefined) return null;
  const harnesses = compatibleHarnesses(connection.service);
  if (!harnesses.includes(pair.harness)) return null;
  const provider = providerOfService(connection.service);
  if (!pair.model.startsWith(`${provider}/`)) return null;
  return pair;
}
