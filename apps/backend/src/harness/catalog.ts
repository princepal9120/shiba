/**
 * Agent CLI catalog — the agentic CLIs baked into the sandbox image, surfaced
 * to the dashboard's Agents view via /api/agents. The image is the install
 * surface (Cloudflare Sandbox containers are ephemeral per run), so this list
 * is static metadata that must mirror the pinned versions in the Dockerfile.
 *
 * Credential reporting is honest by construction: gateway-backed harnesses
 * authenticate through AI Gateway BYOK, which the Worker cannot introspect
 * (configured: null → "AI Gateway" chip); the devin harness needs the
 * DEVIN_API_KEY Worker secret, whose presence IS observable (never the value).
 */
import type { Env } from "../env.js";
import { HARNESS_DEFAULT_MODELS, HARNESS_NAMES } from "./index.js";

export interface AgentCliCredential {
  /** ai-gateway-byok = AI Gateway holds the provider key; worker-secret = a Wrangler secret on this deployment. */
  kind: "ai-gateway-byok" | "worker-secret";
  /** Human-readable credential label, e.g. "DEVIN_API_KEY" or "AI Gateway BYOK (anthropic)". */
  label: string;
  /** true = secret present, false = missing, null = not introspectable (gateway-managed). */
  configured: boolean | null;
  /** Shell hint for the missing-secret case, e.g. "npx wrangler secret put DEVIN_API_KEY". */
  setupHint: string | null;
}

export interface AgentCliInfo {
  /** Harness id — the value the composer/delegate tool pass as `harness`. */
  id: string;
  label: string;
  /** Binary name inside the container. */
  binary: string;
  /** Version pinned in the Dockerfile. */
  version: string;
  /** Default codingModel when neither the run nor the deployment overrides it. */
  defaultModel: string;
  credential: AgentCliCredential;
  docsUrl: string;
}

/** Versions here mirror the Dockerfile pins — bump both together. Keyed by
 * harness name so a new harness fails typecheck until it has catalog metadata. */
const CATALOG_META: Record<
  (typeof HARNESS_NAMES)[number],
  { label: string; binary: string; version: string; docsUrl: string }
> = {
  opencode: { label: "OpenCode", binary: "opencode", version: "1.18.31", docsUrl: "https://opencode.ai/docs/" },
  "claude-code": { label: "Claude Code", binary: "claude", version: "2.1.277", docsUrl: "https://docs.anthropic.com/en/docs/claude-code" },
  codex: { label: "Codex", binary: "codex", version: "0.155.0", docsUrl: "https://github.com/openai/codex" },
  devin: { label: "Devin", binary: "devin", version: "3000.10.31", docsUrl: "https://cli.devin.ai/docs" },
};

const GATEWAY_PROVIDER: Record<string, string> = {
  opencode: "google / anthropic / openai / xAI",
  "claude-code": "anthropic",
  codex: "openai",
};

/**
 * The catalog for this deployment. `env` is read for secret *presence* only —
 * values never leave the Worker.
 */
export function agentCliCatalog(env: Pick<Env, "DEVIN_API_KEY">): AgentCliInfo[] {
  return HARNESS_NAMES.map((id) => {
    const meta = CATALOG_META[id];
    const credential: AgentCliCredential =
      id === "devin"
        ? {
            kind: "worker-secret",
            label: "DEVIN_API_KEY",
            configured: Boolean(env.DEVIN_API_KEY),
            setupHint: "npx wrangler secret put DEVIN_API_KEY",
          }
        : {
            kind: "ai-gateway-byok",
            label: `AI Gateway BYOK (${GATEWAY_PROVIDER[id]})`,
            configured: null,
            setupHint: null,
          };
    return {
      id,
      label: meta.label,
      binary: meta.binary,
      version: meta.version,
      defaultModel: HARNESS_DEFAULT_MODELS[id] as string,
      credential,
      docsUrl: meta.docsUrl,
    };
  });
}
