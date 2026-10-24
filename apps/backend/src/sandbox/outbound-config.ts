/**
 * Persisted outbound rules for Sandbox SDK 1.0 — mirrors the 0.12 class
 * properties on apps/backend/src/sandbox.ts (allowedHosts, outboundByHost,
 * outboundHandlers) plus per-run overrides from approveRepoScope /
 * approveEgressOverrides.
 */
export type NamedOutboundHandler =
  | "denyUnscopedGitHub"
  | "githubScoped"
  | "claudeSubscription"
  | "codexSubscription"
  | "codexPlan"
  | "cursorSubscription"
  | "cursorUser"
  | "antigravityUser"
  | "xaiUser";

/** Host → either a built-in forwarder (egress.ts) or a named handler slot. */
export type OutboundHostRule =
  | { kind: "builtin"; host: string }
  | { kind: "named"; handler: NamedOutboundHandler; params?: Record<string, string> };

export interface OutboundConfig {
  /** Deny-by-default gate — only these hostnames may leave the container. */
  allowedHosts: string[];
  outboundByHost: Record<string, OutboundHostRule>;
  /** Org context for per-org credential injection at egress. */
  orgId?: string;
}

export const OUTBOUND_CONFIG_KEY = "outbound-config-v1";

export const DEFAULT_ALLOWED_HOSTS = [
  "generativelanguage.googleapis.com",
  "github.com",
  "codeload.github.com",
];

export const DEFAULT_OUTBOUND_BY_HOST: Record<string, OutboundHostRule> = {
  "generativelanguage.googleapis.com": { kind: "builtin", host: "generativelanguage.googleapis.com" },
  "api.anthropic.com": { kind: "builtin", host: "api.anthropic.com" },
  "api.openai.com": { kind: "builtin", host: "api.openai.com" },
  "api.x.ai": { kind: "builtin", host: "api.x.ai" },
  "opencode.ai": { kind: "builtin", host: "opencode.ai" },
  "api.deepseek.com": { kind: "builtin", host: "api.deepseek.com" },
  "github.com": { kind: "named", handler: "denyUnscopedGitHub" },
};

/** Fresh config for a new sandbox container generation. */
export function defaultOutboundConfig(): OutboundConfig {
  return {
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
    outboundByHost: { ...DEFAULT_OUTBOUND_BY_HOST },
  };
}

export function loadOutboundConfig(raw: unknown): OutboundConfig {
  if (typeof raw !== "object" || raw === null) return defaultOutboundConfig();
  const allowedHosts = Array.isArray((raw as OutboundConfig).allowedHosts)
    ? (raw as OutboundConfig).allowedHosts.filter((h): h is string => typeof h === "string")
    : defaultOutboundConfig().allowedHosts;
  const outboundByHost =
    typeof (raw as OutboundConfig).outboundByHost === "object" && (raw as OutboundConfig).outboundByHost !== null
      ? { ...(raw as OutboundConfig).outboundByHost }
      : defaultOutboundConfig().outboundByHost;
  const orgId = typeof (raw as OutboundConfig).orgId === "string" ? (raw as OutboundConfig).orgId : undefined;
  return { allowedHosts, outboundByHost, ...(orgId ? { orgId } : {}) };
}
