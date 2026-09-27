/**
 * T50 — `antigravity-subscription` harness (PLAN.md §18.12): Google's
 * Antigravity ACP agent driven by the operator's own Google sign-in on a
 * self-hosted, single-tenant, opted-in deployment. A separate harness —
 * the credential path (OAuth → file storage inside the container profile)
 * and the sign-in surface (pasted loopback redirect) both differ from
 * every other provider.
 *
 * The three load-bearing constraints (all three or it does not ship):
 *
 * 1. The ACP process owns token exchange — the Worker never sees an OAuth
 *    code, only delivers the operator's pasted `http://127.0.0.1/` URL to
 *    the container listener after validating it against the T47 pending
 *    record (single expected state; delivery is not authentication —
 *    only `verify()`'s probe sets `succeeded`).
 * 2. Opted in — the harness registers only under
 *    `SHIBA_ANTIGRAVITY_SUBSCRIPTION=1`; absent the var it is unlisted,
 *    uncataloged, and unselectable. Plain `antigravity` stays excluded
 *    (supportedRuntimes [] by default).
 * 3. Profile isolation — every ACP process runs with `GEMINI_HOME` at a
 *    per-account profile, `AGY_ACP_FORCE_FILE_STORAGE=1` (never the OS
 *    keychain), and the ambient Google credential keys stripped verbatim
 *    per t3code's removedEnvironmentKeys.
 *
 * Ported from t3code (antigravityAuthSupport.ts / antigravityCallback.ts);
 * the rules live in @shiba/shared (`antigravity.ts`) so the Worker-side
 * auth provider and this harness share them without a cross-import.
 */
import {
  antigravityBrowserCommand,
  antigravityEnvironment,
  antigravityProfilePaths,
  antigravityProfileSettings,
  antigravitySubscriptionProfileDir,
} from "@shiba/shared";
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import {
  assertSupportedModel,
  type AgentHarness,
  type HarnessCapabilities,
  type HarnessConfigFile,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import { AntigravityErrorEvent, parseAntigravityEvent } from "./antigravity.js";

/**
 * The subscription auth provider id. Deliberately not PROVIDER_HOSTS.google —
 * no API key exists; the ACP process authenticates with the stored OAuth
 * tokens under the profile.
 */
export const ANTIGRAVITY_SUBSCRIPTION_PROVIDERS = ["google-subscription"] as const;

/**
 * Hosts an Antigravity run may reach — the observed Google surface for the
 * ACP agent: the Cloud Code backend, OAuth endpoints (the in-container
 * process refreshes its own tokens), the sign-in host, the component CDN,
 * and the generative-language fallback. Deny-by-default applies.
 */
export const ANTIGRAVITY_SUBSCRIPTION_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "oauth2.googleapis.com",
  "accounts.google.com",
  "dl.google.com",
  "generativelanguage.googleapis.com",
] as const;


/** The T47 instanceId for an account — stable, never the credential. */
export function antigravitySubscriptionInstanceId(input: { authAccount?: string }): string {
  const account = (input.authAccount ?? "default").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `agy-sub:${account}`;
}

/**
 * Usage-limit signal: a subscription run dying on quota is a first-class
 * verdict, never `completed` — same contract as the other subscription
 * harnesses.
 */
export class AntigravityUsageLimitError extends Error {
  constructor(_detail: string) {
    super("Antigravity subscription usage limit reached.");
    this.name = "AntigravityUsageLimitError";
  }
}

export class AntigravitySubscriptionHarness implements AgentHarness {
  readonly name = "antigravity-subscription" as const;
  readonly supportedProviders = ANTIGRAVITY_SUBSCRIPTION_PROVIDERS;

  /** The run requires a succeeded T47 flow for this instance (§18.12). */
  readonly auth = { instanceId: antigravitySubscriptionInstanceId };

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return [...ANTIGRAVITY_SUBSCRIPTION_HOSTS];
  }

  /** `agy:profile:<dir>` — the account the conversation belongs to. */
  continuationKey(input: { authAccount?: string }): string {
    return `agy:profile:${antigravitySubscriptionProfileDir(input)}`;
  }

  /** The profile's settings.json — auth.type=oauth-personal, never a credential. */
  configFile(input: CodingTaskInput): HarnessConfigFile {
    const paths = antigravityProfilePaths(antigravitySubscriptionProfileDir(input));
    return { path: paths.settingsPath, contents: antigravityProfileSettings() };
  }

  /**
   * Profile dirs before config lands: geminiHome + acpDirectory + tmp,
   * mode 0700 — the token file lives here; looser perms leak credentials.
   */
  setupCommands(input: CodingTaskInput, _workdir: string): readonly (readonly string[])[] {
    const paths = antigravityProfilePaths(antigravitySubscriptionProfileDir(input));
    return [
      ["mkdir", "-p", paths.acpDirectory, paths.tempDirectory],
      ["chmod", "700", paths.geminiHome, paths.acpDirectory],
    ];
  }

  /**
   * Env = the t3code launch environment verbatim: ambient Google keys
   * stripped (the container base env carries none, but a future image
   * could), profile paths forced, file storage pinned, browser suppressed.
   */
  env(input: CodingTaskInput): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    const paths = antigravityProfilePaths(antigravitySubscriptionProfileDir(input));
    return antigravityEnvironment(paths, {}, antigravityBrowserCommand());
  }

  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    // Same one-shot headless contract as the antigravity stub: the pinned
    // `agy` ACP binary runs the task against the profile's stored tokens.
    return [
      "agy",
      "--no-interactive",
      "--yolo",
      "--model",
      stripProvider(input.codingModel),
      input.task,
    ];
  }

  parseEvent(line: string): string | null {
    try {
      return parseAntigravityEvent(line);
    } catch (error) {
      if (
        error instanceof AntigravityErrorEvent &&
        /usage|rate.?limit|quota|sign.?in|auth/i.test(error.detail)
      ) {
        throw new AntigravityUsageLimitError(error.detail);
      }
      throw error;
    }
  }

  capabilities(_model?: string): HarnessCapabilities {
    return {
      streamsText: true,
      emitsToolCalls: true,
      supportsResume: false,
      supportsSteering: false,
      supportsFileAttachments: false,
      // The ACP exec surface can't be provably driven for test commands —
      // honest false, matching the plain antigravity stub.
      canRunTests: false,
      supportsConversationRollback: false,
      execAllowlist: [],
      supportedRuntimes: ["sandbox"],
    };
  }

  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

/** The CLI takes a bare model id; the `provider/` prefix is ours. */
function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const antigravitySubscriptionHarness = new AntigravitySubscriptionHarness();
