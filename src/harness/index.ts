/** Harness registry (PLAN.md T22). Selection is by name, default OpenCode. */
import { claudeCodeHarness } from "./claude-code.js";
import { codexHarness } from "./codex.js";
import { devinHarness } from "./devin.js";
import { opencodeHarness } from "./opencode.js";
import { GIT_EGRESS_HOSTS, type AgentHarness, type AgentHarnessName } from "./types.js";

export const HARNESSES: Record<string, AgentHarness> = {
  opencode: opencodeHarness,
  "claude-code": claudeCodeHarness,
  codex: codexHarness,
  devin: devinHarness,
};

export function resolveHarness(name: string | undefined): AgentHarness {
  if (name === undefined || name.trim() === "") return opencodeHarness;
  const harness = HARNESSES[name.trim().toLowerCase()];
  if (!harness) {
    throw new Error(
      `Unknown agent harness ${JSON.stringify(name)}: expected one of ${Object.keys(HARNESSES).join(", ")}.`,
    );
  }
  return harness;
}

/**
 * The harness for one run: the delegation input wins, then the AGENT_HARNESS
 * deploy default, then OpenCode. Invalid names throw here — before approval —
 * so a bad harness never surfaces as an exec error inside the container.
 */
export function resolveRunHarness(input: string | undefined, envDefault: string | undefined): AgentHarness {
  return resolveHarness(input !== undefined && input.trim() !== "" ? input : envDefault);
}

/**
 * Hosts a run may reach: the SELECTED harness's provider host plus git.
 * Never the union across harnesses — deny-by-default stays deny-by-default.
 */
export function allowedHostsFor(harness: AgentHarness, model: string): string[] {
  return [...harness.egressHosts(model), ...GIT_EGRESS_HOSTS];
}

export type { AgentHarness, AgentHarnessName };

export const HARNESS_NAMES = ["opencode", "claude-code", "codex", "devin"] as const;

/**
 * Per-harness default coding model. The checked-in ids are defaults, not
 * availability guarantees — model ids retire (see configuration.md).
 * Overridable per deploy via CODING_MODEL / CLAUDE_CODE_MODEL / CODEX_MODEL
 * and per run via the delegate tool's codingModel input.
 */
export const HARNESS_DEFAULT_MODELS: Record<string, string> = {
  opencode: "google/gemini-3.5-flash-lite",
  "claude-code": "anthropic/claude-sonnet-4-6",
  codex: "openai/gpt-5.3-codex",
  // swe-2 is free on Devin Pro; the alias resolves to the latest SWE-2.
  devin: "devin/swe-2",
};
