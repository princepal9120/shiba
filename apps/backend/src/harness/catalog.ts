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
import { HARNESS_DEFAULT_MODELS, HARNESS_NAMES, sandboxHarnessNames } from "./index.js";

export interface AgentCliCredential {
  /**
   * ai-gateway-byok = AI Gateway holds the provider key;
   * worker-secret = a Wrangler secret on this deployment;
   * oauth-signin = no Worker credential — the in-container agent process
   * owns an OAuth sign-in (T50 antigravity-subscription).
   */
  kind: "ai-gateway-byok" | "worker-secret" | "oauth-signin";
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
  opencode: { label: "OpenCode", binary: "opencode", version: "1.18.34", docsUrl: "https://opencode.ai/docs/" },
  "claude-code": { label: "Claude Code", binary: "claude", version: "2.1.277", docsUrl: "https://docs.anthropic.com/en/docs/claude-code" },
  "claude-subscription": { label: "Claude Code (subscription)", binary: "claude", version: "2.1.277", docsUrl: "https://docs.anthropic.com/en/docs/claude-code" },
  codex: { label: "Codex", binary: "codex", version: "0.155.0", docsUrl: "https://github.com/openai/codex" },
  "codex-subscription": { label: "Codex (subscription)", binary: "codex", version: "0.155.0", docsUrl: "https://github.com/openai/codex" },
  devin: { label: "Devin", binary: "devin", version: "3000.11.3", docsUrl: "https://cli.devin.ai/docs" },
  grok: { label: "Grok", binary: "grok", version: "1.0.41", docsUrl: "https://docs.x.ai" },
  cursor: { label: "Cursor", binary: "cursor-agent", version: "0.50.0", docsUrl: "https://docs.cursor.com" },
  antigravity: { label: "Antigravity", binary: "agy", version: "1.0.0", docsUrl: "https://antigravity.google" },
  "antigravity-subscription": { label: "Antigravity (subscription)", binary: "agy", version: "1.1.1", docsUrl: "https://antigravity.google" },
  "cursor-subscription": { label: "Cursor (subscription)", binary: "cursor-agent", version: "2026.10.01-e373342", docsUrl: "https://docs.cursor.com" },
  "devin-subscription": { label: "Devin (subscription)", binary: "devin", version: "3000.11.3", docsUrl: "https://cli.devin.ai/docs" },
  // ACP lanes — binaries are the registry's npx/binary entrypoints, all
  // Apache-2.0 or MIT, version-pinned in the Dockerfile.
  "claude-acp": { label: "Claude Agent (ACP)", binary: "claude-agent-acp", version: "0.86.0", docsUrl: "https://agentclientprotocol.com" },
  "codex-acp": { label: "Codex (ACP)", binary: "codex-acp", version: "2.1.1", docsUrl: "https://agentclientprotocol.com" },
  "gemini-acp": { label: "Gemini CLI (ACP)", binary: "gemini", version: "0.62.0", docsUrl: "https://agentclientprotocol.com" },
  "opencode-acp": { label: "OpenCode (ACP)", binary: "opencode", version: "1.18.34", docsUrl: "https://agentclientprotocol.com" },
  "devin-acp": { label: "Devin (ACP)", binary: "devin", version: "3000.11.3", docsUrl: "https://agentclientprotocol.com" },
  // The generic registry lane — binary/version are whatever the pinned
  // snapshot says; the label carries the resolved id at dispatch.
  acp: { label: "ACP registry agent", binary: "acp", version: "per-agent", docsUrl: "https://agentclientprotocol.com/get-started/registry" },
};

const GATEWAY_PROVIDER: Record<string, string> = {
  opencode: "google / anthropic / openai / xAI",
  "claude-code": "anthropic",
  codex: "openai",
  grok: "xAI",
  cursor: "cursor",
  antigravity: "google",
  "claude-acp": "anthropic",
  "codex-acp": "openai",
  "gemini-acp": "google",
  "opencode-acp": "google / anthropic / openai / xAI",
};

/**
 * The catalog for this deployment. `env` is read for secret *presence* only —
 * values never leave the Worker.
 */
export function agentCliCatalog(
  env: Pick<Env, "DEVIN_API_KEY" | "SHIBA_CLAUDE_SUBSCRIPTION" | "CLAUDE_SUBSCRIPTION_TOKEN" | "SHIBA_CODEX_SUBSCRIPTION" | "CODEX_SUBSCRIPTION_AUTH_JSON" | "SHIBA_ANTIGRAVITY_SUBSCRIPTION" | "SHIBA_CURSOR_SUBSCRIPTION" | "CURSOR_SUBSCRIPTION_TOKEN" | "SHIBA_DEVIN_SUBSCRIPTION" | "DEVIN_SUBSCRIPTION_TOKEN" | "ACP_REGISTRY_ALLOWLIST">,
): AgentCliInfo[] {
  return sandboxHarnessNames(env).map((id) => {
    const meta = CATALOG_META[id];
    const credential: AgentCliCredential =
      id === "acp"
        ? {
            // No credential of ours rides a registry agent — admission is
            // the operator's allowlist, credentials are the agent's own.
            kind: "worker-secret",
            label: "ACP_REGISTRY_ALLOWLIST",
            configured: Boolean(env.ACP_REGISTRY_ALLOWLIST?.trim()),
            setupHint: "set ACP_REGISTRY_ALLOWLIST (+ ACP_REGISTRY_JSON snapshot)",
          }
        : id === "devin" || id === "devin-acp"
        ? {
            kind: "worker-secret",
            label: "DEVIN_API_KEY",
            configured: Boolean(env.DEVIN_API_KEY),
            setupHint: "npx wrangler secret put DEVIN_API_KEY",
          }
        : id === "claude-subscription"
          ? {
              kind: "worker-secret",
              label: "CLAUDE_SUBSCRIPTION_TOKEN",
              configured: Boolean(env.CLAUDE_SUBSCRIPTION_TOKEN),
              setupHint: "claude setup-token, then npx wrangler secret put CLAUDE_SUBSCRIPTION_TOKEN",
            }
          : id === "codex-subscription"
            ? {
                kind: "worker-secret",
                label: "CODEX_SUBSCRIPTION_AUTH_JSON",
                configured: Boolean(env.CODEX_SUBSCRIPTION_AUTH_JSON),
                setupHint: "codex login, then npx wrangler secret put CODEX_SUBSCRIPTION_AUTH_JSON < ~/.codex/auth.json",
              }
            : id === "antigravity-subscription"
              ? {
                  // No Worker credential at all — the OAuth tokens live in
                  // the container profile; `configured` is unknowable here.
                  kind: "oauth-signin",
                  label: "Google sign-in (in-container OAuth)",
                  configured: null,
                  setupHint: "POST /api/auth/antigravity-subscription/begin, sign in, paste the 127.0.0.1 redirect into /api/antigravity/callback",
                }
            : id === "cursor-subscription"
              ? {
                  kind: "worker-secret",
                  label: "CURSOR_SUBSCRIPTION_TOKEN",
                  configured: Boolean(env.CURSOR_SUBSCRIPTION_TOKEN),
                  setupHint: "Cursor Agent API key from cursor.com settings, then npx wrangler secret put CURSOR_SUBSCRIPTION_TOKEN",
                }
            : id === "devin-subscription"
              ? {
                  kind: "worker-secret",
                  label: "DEVIN_SUBSCRIPTION_TOKEN",
                  configured: Boolean(env.DEVIN_SUBSCRIPTION_TOKEN),
                  setupHint: "devin auth login, then npx wrangler secret put DEVIN_SUBSCRIPTION_TOKEN",
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
