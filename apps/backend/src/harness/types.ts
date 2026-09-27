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
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";

/** Implemented harnesses. Aider was in the original sketch but has no adapter — add it here with one, not before. */
export type AgentHarnessName = "opencode" | "claude-code" | "codex" | "devin" | "grok" | "cursor" | "antigravity";

/**
 * T43 runtimes a harness can execute under. "sandbox" and the refused
 * "computer" preview exist today; T51 adds "local". A remote executor
 * (cursor) and a not-yet-runnable harness (antigravity) declare `[]` —
 * the runnability gate reads this list, never a parallel name list.
 */
export type RuntimeName = "sandbox" | "computer" | "local";

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
  cursor: "api2.cursor.sh",
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
  cursor: "CURSOR_API_KEY",
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

/**
 * T43 declared capabilities — the interface is the seam: a new harness
 * declares what it can do and the UI/gates read the declaration instead
 * of name-checking. `capabilities` replaces the hardcoded name lists;
 * `supportedRuntimes` is the runnability gate.
 */
export interface HarnessCapabilities {
  streamsText: boolean;
  emitsToolCalls: boolean;
  /** Conversation-resume support in the baked CLI (e.g. claude --resume). */
  supportsResume: boolean;
  /** Mid-run message intake — one-shot CLIs declare false (T31 steers by cancel+re-approval). */
  supportsSteering: boolean;
  supportsFileAttachments: boolean;
  /** The harness can drive a project test command — pairs with T45's executor. */
  canRunTests: boolean;
  /** antigravity's documented trap: no conversation rollback — T44's revert refuses first. */
  supportsConversationRollback: boolean;
  maxContextTokens?: number;
  supportedRuntimes: readonly RuntimeName[];
}

/** Deterministic verify verdict — load-bearing, unlike the advisory quality score. */
export type VerificationOutcome = { ok: true } | { ok: false; reason: string };

/**
 * The shared deterministic verify every sandbox harness runs: a completed
 * run must have produced evidence — a non-empty diff or captured files.
 * Exit 0 with an empty tree is NOT completed; this feeds T46's gate.
 * Non-completed results pass — verify only gates the success claim.
 */
export function verifyRunOutcome(result: CodingTaskResult): VerificationOutcome {
  if (result.status !== "completed") return { ok: true };
  if (result.changedFiles.length === 0 && result.diff.trim() === "") {
    return {
      ok: false,
      reason: "Run exited 0 but produced no file changes — refusing to report a no-op as completed.",
    };
  }
  return { ok: true };
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
  /** Declared capabilities — the runnability gate and UI read these, not the name. */
  capabilities(model?: string): HarnessCapabilities;
  /**
   * Deterministic verification of the run's claimed outcome — load-bearing:
   * the adapter refuses a "completed" result verify rejects. Distinct from
   * result-quality.ts (advisory, fail-open); this never calls a model.
   */
  verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome>;
}
