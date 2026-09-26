/**
 * Agent harness seam (PLAN.md T21/T22/T23).
 *
 * RuntimeAdapter (src/runtime.ts) abstracts *where* work runs — sandbox vs
 * computer. This interface abstracts *what agent* runs inside it: config,
 * argv, container env, and event parsing. Clone, collect, diff, and publish
 * are harness-independent and stay in the runtime adapter.
 *
 * The credential invariant is the same for every harness: the container gets
 * {@link DUMMY_PROVIDER_KEY} and the real credential is swapped in outside
 * the container by the Worker's egress handler (src/egress.ts).
 */
import type { CodingTaskInput } from "../opencode-input.js";

/** Implemented harnesses. Aider was in the original sketch but has no adapter — add it here with one, not before. */
export type AgentHarnessName = "opencode" | "claude-code" | "codex" | "devin" | "grok";

/** Provider id → the single host its API lives on. Feeds allowedHosts (T5). */
export const PROVIDER_HOSTS: Record<string, string> = {
  google: "generativelanguage.googleapis.com",
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  xai: "api.x.ai",
  // Devin is a service harness, not a raw LLM provider: the CLI authenticates
  // to Cognition's control plane, which also fronts the model traffic for
  // Pro accounts (server.codeium.com is added by the adapter's egressHosts).
  devin: "api.devin.ai",
  // OpenCode Go is a key-authenticated subscription endpoint (spec
  // MODEL-CONNECTIONS-ARCHITECTURE.md §3). Its API key is held as an AI
  // Gateway BYOK credential for the opencode-go custom provider; the
  // container still only ever sees the dummy key.
  "opencode-go": "opencode.ai",
};

/** Container env var carrying the dummy key, per provider. */
export const PROVIDER_KEY_ENV: Record<string, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  // The Devin CLI reads its key from credentials.toml, not the environment;
  // the dummy still rides along so a future env-auth path stays covered.
  devin: "DEVIN_API_KEY",
  // OpenCode Go authenticates with its issued API key; the container holds
  // the dummy and the gateway injects the real one at egress.
  "opencode-go": "OPENCODE_GO_API_KEY",
};

/** Hosts every harness needs regardless of provider. */
export const GIT_EGRESS_HOSTS = ["github.com", "codeload.github.com"];

/** `provider/model` → provider. Returns null when the id has no provider part. */
export function providerOf(model: string): string | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return model.slice(0, slash);
}

/**
 * T23. Validates a model against the harness that will run it, replacing the
 * old hard-coded `google/*` rejection (B11). Users may point at any provider
 * their harness and their gateway both understand.
 */
export function assertSupportedModel(harnessName: AgentHarnessName, supported: readonly string[], model: string): string {
  const provider = providerOf(model);
  if (provider === null) {
    throw new Error(
      `Unsupported coding model ${JSON.stringify(model)}: expected "provider/model", e.g. "google/gemini-3.5-flash-lite".`,
    );
  }
  if (!supported.includes(provider)) {
    throw new Error(
      `Unsupported coding model ${JSON.stringify(model)}: the ${harnessName} harness supports ${supported.join(", ")}, not ${JSON.stringify(provider)}.`,
    );
  }
  if (!(provider in PROVIDER_HOSTS)) {
    throw new Error(`Provider ${JSON.stringify(provider)} has no known API host.`);
  }
  return provider;
}

export interface HarnessConfigFile {
  path: string;
  contents: string;
}

export interface AgentHarness {
  readonly name: AgentHarnessName;
  /** Providers this harness can drive. Checked by {@link assertSupportedModel}. */
  readonly supportedProviders: readonly string[];
  /**
   * Hosts a run of this model must reach. Only the SELECTED harness's hosts
   * are allowed — never the union of every harness's.
   */
  egressHosts(model: string): string[];
  /** The config file to write, or null when the harness is configured by env alone. */
  configFile(input: CodingTaskInput, sandboxId: string): HarnessConfigFile | null;
  /** Container env. Provider keys here are always the dummy key. */
  env(input: CodingTaskInput, configPath: string | null): Record<string, string>;
  buildArgv(input: CodingTaskInput, workdir: string): string[];
  /**
   * Parse one streamed event line into progress text. Returns null for blank
   * lines. Throws the harness's event error (e.g. OpenCodeErrorEvent) for
   * error events so the run fails honestly instead of pretending success.
   */
  parseEvent(line: string): string | null;
}
