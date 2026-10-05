/** Harness registry (PLAN.md T22). Selection is by name, default OpenCode. */
import { AcpHarness } from "./acp.js";
import { antigravityHarness } from "./antigravity.js";
import { antigravitySubscriptionHarness } from "./antigravity-subscription.js";
import { claudeCodeHarness } from "./claude-code.js";
import { claudeSubscriptionHarness } from "./claude-subscription.js";
import { codexHarness } from "./codex.js";
import { codexSubscriptionHarness } from "./codex-subscription.js";
import { cursorHarness } from "./cursor.js";
import { cursorSubscriptionHarness } from "./cursor-subscription.js";
import { CONTAINER_XDG_DATA, devinCredentialsConfig, devinHarness } from "./devin.js";
import { devinSubscriptionHarness } from "./devin-subscription.js";
import { grokHarness } from "./grok.js";
import { buildOpencodeConfig, OPENCODE_PROVIDERS, opencodeHarness } from "./opencode.js";
import type { Env } from "../env.js";
import { GIT_EGRESS_HOSTS, type AgentHarness, type AgentHarnessName, type RuntimeName } from "./types.js";

const REGISTRY = {
  opencode: opencodeHarness,
  "claude-code": claudeCodeHarness,
  "claude-subscription": claudeSubscriptionHarness,
  codex: codexHarness,
  "codex-subscription": codexSubscriptionHarness,
  devin: devinHarness,
  grok: grokHarness,
  cursor: cursorHarness,
  antigravity: antigravityHarness,
  "antigravity-subscription": antigravitySubscriptionHarness,
  "cursor-subscription": cursorSubscriptionHarness,
  "devin-subscription": devinSubscriptionHarness,
  // ACP registry agents (PLAN-V2-NEXT): every ACP-capable CLI the image ships
  // is selectable as a harness. Spawn argv match the ACP registry entries;
  // credentials ride the provider's existing BYOK/worker-secret lane.
  "claude-acp": new AcpHarness({
    name: "claude-acp",
    label: "Claude ACP",
    spawn: ["claude-agent-acp"],
    providers: ["anthropic"],
  }),
  "codex-acp": new AcpHarness({
    name: "codex-acp",
    label: "Codex ACP",
    spawn: ["codex-acp"],
    providers: ["openai"],
  }),
  // gemini-cli reads GEMINI_API_KEY, not the provider's standard env var.
  "gemini-acp": new AcpHarness({
    name: "gemini-acp",
    label: "Gemini ACP",
    spawn: ["gemini", "--acp"],
    providers: ["google"],
    keyEnv: "GEMINI_API_KEY",
  }),
  "opencode-acp": new AcpHarness({
    name: "opencode-acp",
    label: "OpenCode ACP",
    spawn: ["opencode", "acp"],
    providers: OPENCODE_PROVIDERS,
    // OpenCode's ACP modelId grammar is `provider/model[/variant]` — the
    // default strip would drop the provider segment it resolves against.
    modelId: (model) => model,
    // `opencode acp` reads the same opencode.json the run lane writes
    // (enabled_providers, dummy apiKey, autoupdate off) via OPENCODE_CONFIG.
    extraConfig: (input, sandboxId) => [
      {
        path: `/workspace/${sandboxId}.opencode.json`,
        contents: JSON.stringify(buildOpencodeConfig(input), null, 2),
      },
    ],
    extraEnv: (_input, configPath) => ({
      ...(configPath ? { OPENCODE_CONFIG: configPath } : {}),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    }),
  }),
  "devin-acp": new AcpHarness({
    name: "devin-acp",
    label: "Devin ACP",
    spawn: ["devin", "acp"],
    providers: ["devin"],
    // api.devin.ai comes from the provider host; the CLI's inference backend
    // (server.codeium.com, Pro accounts) is the second egress host.
    extraEgress: ["server.codeium.com"],
    // `devin acp` authenticates from credentials.toml, not the env var —
    // same dummy file the devin lane writes (real key swaps in at egress).
    extraConfig: () => [devinCredentialsConfig()],
    extraEnv: () => ({ XDG_DATA_HOME: CONTAINER_XDG_DATA }),
  }),
} satisfies Record<AgentHarnessName, AgentHarness>;

export const HARNESSES: Record<string, AgentHarness> = REGISTRY;

/** The env surface the opt-in gate reads. */
type HarnessGateEnv = {
  SHIBA_CLAUDE_SUBSCRIPTION?: string;
  SHIBA_CODEX_SUBSCRIPTION?: string;
  SHIBA_ANTIGRAVITY_SUBSCRIPTION?: string;
  SHIBA_CURSOR_SUBSCRIPTION?: string;
  SHIBA_DEVIN_SUBSCRIPTION?: string;
} | undefined;

/**
 * T48: opt-in subscription harnesses are *unregistered* unless the
 * deployment explicitly enables them — absent the var they are not
 * resolvable, not cataloged, not selectable (§18.10). The default is
 * closed: a caller that threads no env cannot select a gated harness.
 */
const HARNESS_GATES: Partial<Record<AgentHarnessName, (env: HarnessGateEnv) => boolean>> = {
  "claude-subscription": (env) => env?.SHIBA_CLAUDE_SUBSCRIPTION === "1",
  "codex-subscription": (env) => env?.SHIBA_CODEX_SUBSCRIPTION === "1",
  // T50: the OAuth-in-container flow is opt-in separately (§18.12).
  "antigravity-subscription": (env) => env?.SHIBA_ANTIGRAVITY_SUBSCRIPTION === "1",
  // Worker-secret subscription keys (CURSOR_SUBSCRIPTION_TOKEN /
  // DEVIN_SUBSCRIPTION_TOKEN), opt-in like the other subscription harnesses.
  "cursor-subscription": (env) => env?.SHIBA_CURSOR_SUBSCRIPTION === "1",
  "devin-subscription": (env) => env?.SHIBA_DEVIN_SUBSCRIPTION === "1",
};

function harnessEnabled(harness: AgentHarness, env: HarnessGateEnv): boolean {
  const gate = HARNESS_GATES[harness.name as AgentHarnessName];
  return gate === undefined || gate(env);
}

function subscriptionFlagName(name: AgentHarnessName): string {
  const provider = name.replace(/-subscription$/, "").replace(/-/g, "_").toUpperCase();
  return `SHIBA_${provider}_SUBSCRIPTION`;
}

/** Whether a harness sits behind an opt-in flag at all (ignoring whether the flag is set). */
export function harnessIsGated(harness: AgentHarness): boolean {
  return HARNESS_GATES[harness.name as AgentHarnessName] !== undefined;
}

export function resolveHarness(name: string | undefined, env?: HarnessGateEnv): AgentHarness {
  if (name === undefined || name.trim() === "") return opencodeHarness;
  const harness = HARNESSES[name.trim().toLowerCase()];
  if (!harness || !harnessEnabled(harness, env)) {
    const selectable = Object.values(HARNESSES)
      .filter((entry) => harnessEnabled(entry, env))
      .map((entry) => entry.name)
      .join(", ");
    const gateMessage =
      harness !== undefined && harnessIsGated(harness)
        ? `; it is not enabled (set ${subscriptionFlagName(harness.name as AgentHarnessName)}=1)`
        : "";
    throw new Error(
      `Unknown agent harness ${JSON.stringify(name)}${gateMessage}: expected one of ${selectable}.`,
    );
  }
  // Registered is not runnable: cursor/antigravity have no CLI in the sandbox
  // image (their auth can't hold the dummy-key invariant), so refuse them at
  // selection — before the approval card — rather than failing in-container.
  // T43: the gate reads the harness's declared supportedRuntimes, not a name list.
  if (!harnessRunsOn(harness, "sandbox")) {
    throw new Error(
      `Agent harness ${JSON.stringify(harness.name)} is not runnable in a sandbox: expected one of ${SANDBOX_HARNESS_NAMES.join(", ")}.`,
    );
  }
  return harness;
}

/** T43: a harness runs under a runtime when it declares it. */
export function harnessRunsOn(harness: AgentHarness, runtime: RuntimeName): boolean {
  return harness.capabilities().supportedRuntimes.includes(runtime);
}

/**
 * Harnesses the sandbox image can actually drive — derived from declared
 * capabilities (T43), not a parallel name list. Cursor and Antigravity stay
 * registered for catalog/type surfaces but declare no runtimes.
 */
export const SANDBOX_HARNESS_NAMES: readonly AgentHarnessName[] = Object.values(HARNESSES)
  .filter((harness) => harnessRunsOn(harness, "sandbox") && HARNESS_GATES[harness.name as AgentHarnessName] === undefined)
  .map((harness) => harness.name);

/** Sandbox harnesses for this deployment — the always-on list plus any gated harness the flag enabled. */
export function sandboxHarnessNames(env: HarnessGateEnv): readonly AgentHarnessName[] {
  return Object.values(HARNESSES)
    .filter((harness) => harnessRunsOn(harness, "sandbox") && harnessEnabled(harness, env))
    .map((harness) => harness.name);
}

/**
 * The harness for one run: the delegation input wins, then the AGENT_HARNESS
 * deploy default, then OpenCode. Invalid names throw here — before approval —
 * so a bad harness never surfaces as an exec error inside the container.
 */
export function resolveRunHarness(input: string | undefined, envDefault: string | undefined, env?: HarnessGateEnv): AgentHarness {
  return resolveHarness(input !== undefined && input.trim() !== "" ? input : envDefault, env);
}

/**
 * Hosts a run may reach: the SELECTED harness's provider host plus git.
 * Never the union across harnesses — deny-by-default stays deny-by-default.
 */
export function allowedHostsFor(harness: AgentHarness, model: string): string[] {
  return [...harness.egressHosts(model), ...GIT_EGRESS_HOSTS];
}

export type { AgentHarness };

export const HARNESS_NAMES = Object.keys(REGISTRY) as readonly AgentHarnessName[];

/**
 * Per-harness default coding model. The checked-in ids are defaults, not
 * availability guarantees — model ids retire (see configuration.md).
 * Overridable per deploy via CODING_MODEL / CLAUDE_CODE_MODEL / CODEX_MODEL /
 * DEVIN_MODEL / GROK_MODEL and the per-harness *_SUBSCRIPTION_MODEL vars, and
 * per run via the delegate tool's codingModel input.
 */
export const HARNESS_DEFAULT_MODELS: Record<string, string> = {
  opencode: "google/gemini-3.5-flash-lite",
  "claude-code": "anthropic/claude-sonnet-4-6",
  // Subscription models carry the anthropic-subscription namespace: the
  // provider prefix is the auth-path distinction, not a different vendor.
  "claude-subscription": "anthropic-subscription/claude-sonnet-4-6",
  codex: "openai/gpt-5.3-codex",
  // ChatGPT-subscription models carry the openai-subscription namespace:
  // the provider prefix is the auth-path distinction, not a different vendor.
  "codex-subscription": "openai-subscription/gpt-5.3-codex",
  // SWE-2 medium is the free tier on Devin Pro; bare "swe-2" is a family
  // name the pinned CLI (3000.11.3) does not resolve, and "swe" is the
  // family alias.
  devin: "devin/swe-2-medium",
  grok: "xai/grok-4.6",
  cursor: "cursor/claude-4-5-sonnet",
  antigravity: "google/gemini-3.5-flash",
  // Subscription models carry the google-subscription namespace: the
  // provider prefix is the auth-path distinction, not a different vendor.
  "antigravity-subscription": "google-subscription/gemini-3-pro",
  // "auto" is cursor-agent's own model picker — the subscription lane's
  // sensible default since the operator's plan governs what resolves.
  "cursor-subscription": "cursor-subscription/auto",
  "devin-subscription": "devin-subscription/swe-2-medium",
  // ACP lanes inherit the provider's default model.
  "claude-acp": "anthropic/claude-sonnet-4-6",
  "codex-acp": "openai/gpt-5.3-codex",
  "gemini-acp": "google/gemini-3.5-flash",
  "opencode-acp": "google/gemini-3.5-flash-lite",
  "devin-acp": "devin/swe-2-medium",
};

/**
 * Harness → the env var that overrides its default model at the deployment
 * level. ACP lanes share their provider harness's var rather than growing
 * five new vars; a per-run `codingModel` still beats both. `keyof Env` keeps
 * a rename compile-time loud.
 */
/** Keys of Env whose values are strings — the only vars a model id can live in. */
type StringEnvKey = { [K in keyof Env]: Env[K] extends string | undefined ? K : never }[keyof Env];

export const HARNESS_MODEL_ENV: Record<AgentHarnessName, StringEnvKey | undefined> = {
  opencode: "CODING_MODEL",
  "claude-code": "CLAUDE_CODE_MODEL",
  "claude-subscription": "CLAUDE_SUBSCRIPTION_MODEL",
  codex: "CODEX_MODEL",
  "codex-subscription": "CODEX_SUBSCRIPTION_MODEL",
  devin: "DEVIN_MODEL",
  grok: "GROK_MODEL",
  cursor: "CODING_MODEL",
  antigravity: "CODING_MODEL",
  "antigravity-subscription": "ANTIGRAVITY_SUBSCRIPTION_MODEL",
  "cursor-subscription": "CURSOR_SUBSCRIPTION_MODEL",
  "devin-subscription": "DEVIN_SUBSCRIPTION_MODEL",
  "claude-acp": "CLAUDE_CODE_MODEL",
  "codex-acp": "CODEX_MODEL",
  "gemini-acp": "CODING_MODEL",
  "opencode-acp": "CODING_MODEL",
  "devin-acp": "DEVIN_MODEL",
};
