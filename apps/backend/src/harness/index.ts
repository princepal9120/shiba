/** Harness registry (PLAN.md T22). Selection is by name, default OpenCode. */
import { antigravityHarness } from "./antigravity.js";
import { claudeCodeHarness } from "./claude-code.js";
import { claudeSubscriptionHarness } from "./claude-subscription.js";
import { codexHarness } from "./codex.js";
import { codexSubscriptionHarness } from "./codex-subscription.js";
import { cursorHarness } from "./cursor.js";
import { devinHarness } from "./devin.js";
import { grokHarness } from "./grok.js";
import { opencodeHarness } from "./opencode.js";
import { GIT_EGRESS_HOSTS, type AgentHarness, type AgentHarnessName, type RuntimeName } from "./types.js";

export const HARNESSES: Record<string, AgentHarness> = {
  opencode: opencodeHarness,
  "claude-code": claudeCodeHarness,
  "claude-subscription": claudeSubscriptionHarness,
  codex: codexHarness,
  "codex-subscription": codexSubscriptionHarness,
  devin: devinHarness,
  grok: grokHarness,
  cursor: cursorHarness,
  antigravity: antigravityHarness,
};

/** The env surface the opt-in gate reads. */
type HarnessGateEnv = { SHIBA_CLAUDE_SUBSCRIPTION?: string; SHIBA_CODEX_SUBSCRIPTION?: string } | undefined;

/**
 * T48: opt-in subscription harnesses are *unregistered* unless the
 * deployment explicitly enables them — absent the var they are not
 * resolvable, not cataloged, not selectable (§18.10). The default is
 * closed: a caller that threads no env cannot select a gated harness.
 */
const HARNESS_GATES: Partial<Record<AgentHarnessName, (env: HarnessGateEnv) => boolean>> = {
  "claude-subscription": (env) => env?.SHIBA_CLAUDE_SUBSCRIPTION === "1",
  "codex-subscription": (env) => env?.SHIBA_CODEX_SUBSCRIPTION === "1",
};

function harnessEnabled(harness: AgentHarness, env: HarnessGateEnv): boolean {
  const gate = HARNESS_GATES[harness.name as AgentHarnessName];
  return gate === undefined || gate(env);
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
    throw new Error(
      `Unknown agent harness ${JSON.stringify(name)}: expected one of ${selectable}.`,
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

export type { AgentHarness, AgentHarnessName };

export const HARNESS_NAMES = ["opencode", "claude-code", "claude-subscription", "codex", "codex-subscription", "devin", "grok", "cursor", "antigravity"] as const;

/**
 * Per-harness default coding model. The checked-in ids are defaults, not
 * availability guarantees — model ids retire (see configuration.md).
 * Overridable per deploy via CODING_MODEL / CLAUDE_CODE_MODEL / CODEX_MODEL /
 * DEVIN_MODEL / GROK_MODEL and per run via the delegate tool's codingModel input.
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
  // name the pinned CLI (3000.10.31) does not resolve, and "swe" is the
  // family alias.
  devin: "devin/swe-2-medium",
  grok: "xai/grok-4.6",
  cursor: "cursor/claude-4-5-sonnet",
  antigravity: "google/gemini-3.5-flash",
};
