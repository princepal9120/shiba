/**
 * T48 — `claude-subscription` harness (PLAN.md §18.10): Claude Code driven
 * by the operator's own `claude setup-token` credential on a self-hosted,
 * single-tenant, opted-in deployment. A separate harness, not a mode flag
 * on `claude-code` — the credential path, egress hosts, and trust model
 * all differ.
 *
 * The three load-bearing constraints (all three or it does not ship):
 *
 * 1. `claude setup-token` handoff, never `claude auth login` — the app
 *    never drives or brokers an Anthropic login. The operator runs
 *    `claude setup-token` on their own machine and stores the printed
 *    token as the Worker secret `CLAUDE_SUBSCRIPTION_TOKEN` (named
 *    accounts: `CLAUDE_SUBSCRIPTION_TOKEN_<ACCOUNT>`).
 * 2. Opted in — the harness is only registered when the deployment sets
 *    `SHIBA_CLAUDE_SUBSCRIPTION=1` (see harness/index.ts); absent the var
 *    it is unlisted, uncataloged, and unselectable.
 * 3. The token never enters the container — the sandbox gets a
 *    `CLAUDE_CONFIG_DIR` layout with a *placeholder* `.credentials.json`
 *    (enough for the CLI to enter subscription mode); the subscription
 *    egress branch (src/egress.ts `forwardClaudeSubscription`) attaches
 *    `Authorization: Bearer <token>` plus the oauth beta header. On this
 *    path api.anthropic.com must NOT ride the gateway's BYOK
 *    (API-key) route — the per-run `egressOverrides` swap its handler to
 *    the subscription branch, which is deny-by-default and attaches only
 *    the token.
 *
 * Ports from t3code (`ClaudeHome.ts` / `ClaudeDriver.ts`): isolate via
 * `CLAUDE_CONFIG_DIR`, never `HOME` (overriding HOME would relocate the
 * keychain lookup — moot in the Linux sandbox but load-bearing for T51
 * local); continuation key `claude:home:<resolvedConfigDir>`; no
 * `ANTHROPIC_API_KEY` at all — a cached API key conflicts with the
 * subscription credential, and a stored secret is not proof of access.
 */
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import {
  assertSupportedModel,
  type AgentHarness,
  type HarnessCapabilities,
  type HarnessConfigFile,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import { ClaudeCodeErrorEvent, parseClaudeCodeEvent } from "./claude-code.js";

/** The subscription auth provider id — deliberately not PROVIDER_HOSTS.anthropic. */
export const CLAUDE_SUBSCRIPTION_PROVIDERS = ["anthropic-subscription"] as const;

/**
 * Hosts a subscription run may reach — the observed set for a setup-token
 * CLI: the Messages API plus the account host the CLI consults for its
 * oauth profile/refresh surface. Statsig/telemetry stay unreachable;
 * DISABLE_TELEMETRY is set anyway. Both hosts ride the subscription
 * branch (egressOverrides), not the gateway.
 */
export const CLAUDE_SUBSCRIPTION_HOSTS = ["api.anthropic.com", "claude.ai"] as const;

/** The placeholder the sandbox's credentials file carries — never a real token. */
export const CLAUDE_SUBSCRIPTION_PLACEHOLDER = "shiba-egress-placeholder";

/** Account selector carried on the task envelope; "default" → CLAUDE_SUBSCRIPTION_TOKEN. */
export function claudeSubscriptionAccount(input: CodingTaskInput): string {
  return input.authAccount ?? "default";
}

/** The T47 instanceId for an account — stable, never the credential. */
export function claudeSubscriptionInstanceId(input: CodingTaskInput): string {
  return `claude-sub:${claudeSubscriptionAccount(input)}`;
}

/**
 * Per-instance config dir inside the sandbox: isolate conversation state
 * by account without touching HOME. `/root` is the container's HOME (the
 * image runs root); the path is part of the continuation key, so it must
 * be deterministic per account.
 */
export function claudeSubscriptionConfigDir(input: CodingTaskInput): string {
  const account = claudeSubscriptionAccount(input).replace(/[^a-z0-9-]/g, "-");
  return `/root/.shiba/claude/${account}`;
}

/**
 * Detect a real cached OAuth login in a `.credentials.json` — an inherited
 * home carrying `claudeAiOauth` with a live access/refresh pair would
 * silently outrank the placeholder layout, so it is refused, never used.
 */
export function hasConflictingOAuthCredential(credentialsJson: string): boolean {
  try {
    const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
    const oauth = parsed.claudeAiOauth;
    if (typeof oauth !== "object" || oauth === null) return false;
    const record = oauth as Record<string, unknown>;
    return (
      typeof record.accessToken === "string" &&
      record.accessToken.length > 0 &&
      record.accessToken !== CLAUDE_SUBSCRIPTION_PLACEHOLDER &&
      typeof record.refreshToken === "string"
    );
  } catch {
    return false;
  }
}

/** Placeholder `.credentials.json` — marks subscription mode, carries no secret. */
export function claudeSubscriptionCredentialsFile(dir: string): HarnessConfigFile {
  return {
    path: `${dir}/.credentials.json`,
    contents: JSON.stringify({
      claudeAiOauth: {
        accessToken: CLAUDE_SUBSCRIPTION_PLACEHOLDER,
        refreshToken: "",
        expiresAt: 4_102_444_800_000,
        scopes: ["user:inference"],
        subscriptionType: "pro",
      },
    }),
  };
}

/**
 * Usage-limit signal: a subscription run dying on quota is a first-class
 * verdict — "usage limit reached, resets at X" — never a stack trace and
 * never `completed`. The stream-json error envelope lands in
 * ClaudeCodeErrorEvent.detail; pull the reset hint out of it when present.
 */
export class ClaudeUsageLimitError extends Error {
  readonly resetsAt: string | null;
  constructor(detail: string) {
    const reset =
      detail.match(/resets?\s+(?:at|on)\s+([A-Za-z0-9:.,+/_\s-]{4,40})/i)?.[1]?.trim() ??
      detail.match(/(20[0-9]{2}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+Z?)/)?.[1] ??
      null;
    super(
      reset !== null
        ? `Claude subscription usage limit reached, resets at ${reset}.`
        : "Claude subscription usage limit reached.",
    );
    this.name = "ClaudeUsageLimitError";
    this.resetsAt = reset;
  }
}

export class ClaudeSubscriptionHarness implements AgentHarness {
  readonly name = "claude-subscription" as const;
  readonly supportedProviders = CLAUDE_SUBSCRIPTION_PROVIDERS;

  /** The run requires a succeeded T47 flow for this instance (§18.10). */
  readonly auth = { instanceId: claudeSubscriptionInstanceId };

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return [...CLAUDE_SUBSCRIPTION_HOSTS];
  }

  /**
   * The subscription branch owns every host this harness opens — including
   * api.anthropic.com, whose static map entry is the API-key gateway path.
   * Params carry the account name, never the token.
   */
  egressOverrides(input: CodingTaskInput) {
    const account = claudeSubscriptionAccount(input);
    return CLAUDE_SUBSCRIPTION_HOSTS.map((host) => ({
      host,
      handler: "claudeSubscription",
      params: { account },
    }));
  }

  /** `claude:home:<resolvedConfigDir>` — the account the conversation belongs to. */
  continuationKey(input: CodingTaskInput): string {
    return `claude:home:${claudeSubscriptionConfigDir(input)}`;
  }

  /** The placeholder credentials file; CLAUDE_CONFIG_DIR points the CLI at its dir. */
  configFile(input: CodingTaskInput): HarnessConfigFile {
    return claudeSubscriptionCredentialsFile(claudeSubscriptionConfigDir(input));
  }

  env(input: CodingTaskInput): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return {
      // Isolate via CLAUDE_CONFIG_DIR, never HOME. No ANTHROPIC_API_KEY at
      // all — an API key outranks the subscription credential and would
      // route to the API-key path with the dummy.
      CLAUDE_CONFIG_DIR: claudeSubscriptionConfigDir(input),
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    };
  }

  buildArgv(input: CodingTaskInput, workdir: string): string[] {
    // Identical shape to claude-code: --print --output-format stream-json
    // --permission-mode acceptEdits. The parser is reused verbatim.
    return [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--model",
      stripProvider(input.codingModel),
      "--add-dir",
      workdir,
      input.task,
    ];
  }

  parseEvent(line: string): HarnessEvent | null {
    try {
      return parseClaudeCodeEvent(line);
    } catch (error) {
      if (error instanceof ClaudeCodeErrorEvent && /usage|rate.?limit|quota/i.test(error.detail)) {
        throw new ClaudeUsageLimitError(error.detail);
      }
      throw error;
    }
  }

  capabilities(_model?: string): HarnessCapabilities {
    return {
      streamsText: true,
      emitsToolCalls: true,
      supportsResume: true,
      supportsSteering: false,
      supportsFileAttachments: false,
      canRunTests: true,
      supportsConversationRollback: false,
      execAllowlist: [["pnpm","test"],["npm","test"],["bun","test"],["pnpm","vitest","run"],["npx","vitest","run"]],
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

export const claudeSubscriptionHarness = new ClaudeSubscriptionHarness();
