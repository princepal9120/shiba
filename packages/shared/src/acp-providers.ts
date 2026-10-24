export const ACP_PROVIDER_IDS = ["claude", "codex", "gemini", "grok", "cursor"] as const;
export type AcpProviderId = (typeof ACP_PROVIDER_IDS)[number];

export interface AcpProviderCapabilities {
  streamsText: boolean;
  toolCalls: boolean;
  permissions: boolean;
  setModel: boolean;
  oauth: boolean;
  apiKey: boolean;
  acp: boolean;
}

export type AcpConnectionPhase = "disconnected" | "waiting" | "connected" | "failed";
export type AcpAuthMode = "oauth" | "api-key";

/** How a waiting or connected sign-in was started. Never a locally invented device code. */
export const ACP_SIGN_IN_KINDS = [
  "chatgpt-device",
  "chatgpt-pkce",
  "claude-daemon",
  "claude-setup-token",
  "antigravity-pkce",
  "cursor-pkce",
  "xai-pkce",
] as const;
export type AcpSignInKind = (typeof ACP_SIGN_IN_KINDS)[number];

export interface AcpProviderConnection {
  phase: AcpConnectionPhase;
  authMode: AcpAuthMode | null;
  message: string | null;
  /** Vendor device code when ChatGPT device sign-in is waiting. Never a code this page invented. */
  userCode: string | null;
  /** Real vendor authorize URL when a ChatGPT PKCE sign-in is waiting. Never a marketing homepage. */
  verificationUri: string | null;
  expiresAt: number | null;
  testedAt: number | null;
  testOk: boolean | null;
  signInKind?: AcpSignInKind | null;
  /** PKCE OAuth state while sign-in is waiting (local loopback polling). */
  oauthState?: string | null;
  /** Exact operator steps when the lane cannot connect, or the remaining steps while it is waiting. */
  operatorSteps?: string[];
}

export interface AcpProviderCard {
  id: AcpProviderId;
  label: string;
  blurb: string;
  adapter: string;
  packageName: string;
  license: string;
  harness: string;
  protocol: "acp" | "cli";
  spawn: string[];
  defaultModel: string;
  docsUrl: string;
  capabilities: AcpProviderCapabilities;
  credentialEnv: string[];
  connection: AcpProviderConnection;
  isDefault: boolean;
}

export interface AcpProvidersSnapshot {
  org: string;
  defaultProviderId: AcpProviderId | null;
  providers: AcpProviderCard[];
}

export function isAcpProviderId(value: string): value is AcpProviderId {
  return (ACP_PROVIDER_IDS as readonly string[]).includes(value);
}
