/**
 * T49 — `codex-subscription` harness (PLAN.md §18.11): the Codex CLI
 * driven by the operator's own ChatGPT subscription credential on a
 * self-hosted, single-tenant, opted-in deployment. A separate harness,
 * not a flag on `codex` — the credential is directory-shaped
 * (`CODEX_HOME/auth.json`), not an env var, so the mechanism differs from
 * T48's flat token.
 *
 * Constraints carried verbatim from §18.10:
 *
 * 1. `codex login` handoff, never brokered — the operator runs it on their
 *    own machine and stores the resulting `auth.json` contents as the
 *    Worker secret `CODEX_SUBSCRIPTION_AUTH_JSON` (named accounts:
 *    `CODEX_SUBSCRIPTION_AUTH_JSON_<ACCOUNT>`). The app never drives the
 *    OAuth flow itself.
 * 2. Opted in — registered only when the deployment sets
 *    `SHIBA_CODEX_SUBSCRIPTION=1`; a distinct var so an operator can enable
 *    one subscription provider without the other.
 * 3. `auth.json` never enters the container as a real credential — the
 *    sandbox's effective home gets a *stub* `auth.json` (placeholder JWT,
 *    never a symlink into the shared home); the real access token is
 *    attached by the subscription egress branch (src/egress.ts
 *    `forwardCodexSubscription`) on the ChatGPT backend host, which rides
 *    its own deny-by-default handler — `GATEWAY_PROVIDERS` correctly has
 *    no entry for it.
 *
 * Ports from t3code (`CodexHomeLayout.ts`): the two-level home — a SHARED
 * home holding non-account-specific entries (the known-shared list is
 * verbatim) plus a per-account SHADOW overlaying `auth.json`. Continuation
 * key follows the shared home (`codex:home:<sharedHomePath>` — a thread
 * survives an account switch); account identity follows the directory that
 * actually holds `auth.json` (`effectiveHomePath ?? sharedHomePath`).
 * Updates target the shared home, never the overlay — the overlay does
 * not contain the installation and an updater run there silently no-ops.
 */
import { codexShadowHomeOps, resolveCodexSubscriptionHome, type CodexHomeLayout } from "@shiba/shared";
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
import { CodexErrorEvent, parseCodexEvent } from "./codex.js";

/** The subscription auth provider id — deliberately not PROVIDER_HOSTS.openai. */
export const CODEX_SUBSCRIPTION_PROVIDERS = ["openai-subscription"] as const;

/**
 * Hosts a subscription run may reach — the ChatGPT backend the CLI hits in
 * `chatgpt` auth mode (`/backend-api/codex/*`, `/backend-api/wham/*`).
 * Token refresh (auth.openai.com) is deliberately NOT admitted: a refresh
 * response would carry real tokens into the container. An expired access
 * token fails the run honestly and the operator re-stores the secret.
 */
export const CODEX_SUBSCRIPTION_HOSTS = ["chatgpt.com"] as const;

/** The placeholder the sandbox's auth.json carries — never a real token. */
export const CODEX_SUBSCRIPTION_PLACEHOLDER = "shiba-egress-placeholder";

/** The shared home every account's threads live in. */
export const CODEX_SUBSCRIPTION_SHARED_HOME = "/root/.shiba/codex/shared";

/** Account selector carried on the task envelope; "default" → CODEX_SUBSCRIPTION_AUTH_JSON. */
export function codexSubscriptionAccount(input: Pick<CodingTaskInput, "authAccount">): string {
  return input.authAccount ?? "default";
}

/**
 * The layout for one run. The default account rides the shared home
 * directly (direct mode — the primary account's auth.json lives in the
 * shared home, as in t3code); a named account gets a shadow at
 * `acc-<name>` that owns its stub `auth.json` while linking the shared
 * state in.
 */
export function codexSubscriptionHome(input: Pick<CodingTaskInput, "authAccount">): CodexHomeLayout {
  const account = codexSubscriptionAccount(input).replace(/[^a-z0-9-]/g, "-");
  return resolveCodexSubscriptionHome({
    sharedHomePath: CODEX_SUBSCRIPTION_SHARED_HOME,
    shadowHomePath: account === "default" ? undefined : `/root/.shiba/codex/acc-${account}`,
  });
}

/** The directory that actually holds this run's auth.json. */
export function codexSubscriptionHomeDir(input: Pick<CodingTaskInput, "authAccount">): string {
  const layout = codexSubscriptionHome(input);
  return layout.effectiveHomePath ?? layout.sharedHomePath;
}

/**
 * The T47 instanceId — keyed on the directory holding auth.json (the
 * account), never the shared home (the thread). `codex-sub:<path>`.
 */
export function codexSubscriptionInstanceId(input: Pick<CodingTaskInput, "authAccount">): string {
  return `codex-sub:${codexSubscriptionHomeDir(input)}`;
}

// `codexSubscriptionAccountFromInstanceId` lives in @shiba/shared
// (codex-home.ts) — src/auth/ must not import from harness/.
export { codexSubscriptionAccountFromInstanceId } from "@shiba/shared";

/**
 * The stub `auth.json` — shape-valid (the CLI parses the ChatGPT-auth
 * record and decodes the access token's JWT payload for expiry), carrying
 * placeholders only. The materializer writes it as a real file; the
 * private-entry-symlink refusal (@shiba/shared codex-home) refuses a
 * symlinked auth.json before any write.
 */
export function codexSubscriptionAuthFile(homeDir: string): HarnessConfigFile {
  return {
    path: `${homeDir}/auth.json`,
    contents: JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: null,
        access_token: placeholderJwt(),
        refresh_token: "",
        account_id: CODEX_SUBSCRIPTION_PLACEHOLDER,
      },
      last_refresh: 0,
    }),
  };
}

/** A syntactically valid JWT whose payload is a far-future placeholder — the CLI decodes exp, never the signature. */
export function placeholderJwt(): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "");
  const payload = btoa(JSON.stringify({ exp: 4_102_444_800, sub: CODEX_SUBSCRIPTION_PLACEHOLDER })).replace(/=+$/, "");
  return `${header}.${payload}.${CODEX_SUBSCRIPTION_PLACEHOLDER}`;
}

/** The config.toml selecting ChatGPT auth — without it codex would look for an API key. */
export function codexSubscriptionConfigToml(homeDir: string): HarnessConfigFile {
  return {
    path: `${homeDir}/config.toml`,
    contents: 'preferred_auth_method = "chatgpt"\n',
  };
}

/**
 * Usage-limit signal: a subscription run dying on quota is a first-class
 * verdict — never a stack trace and never `completed`.
 */
export class CodexUsageLimitError extends Error {
  constructor(detail: string) {
    super(`Codex subscription usage limit reached. ${detail}`);
    this.name = "CodexUsageLimitError";
  }
}

export class CodexSubscriptionHarness implements AgentHarness {
  readonly name = "codex-subscription" as const;
  readonly supportedProviders = CODEX_SUBSCRIPTION_PROVIDERS;

  /** The run requires a succeeded T47 flow for this instance (§18.11). */
  readonly auth = { instanceId: codexSubscriptionInstanceId };

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return [...CODEX_SUBSCRIPTION_HOSTS];
  }

  /** chatgpt.com rides the subscription branch, params carry the account name only. */
  egressOverrides(input: CodingTaskInput) {
    return CODEX_SUBSCRIPTION_HOSTS.map((host) => ({
      host,
      handler: "codexSubscription",
      params: { account: codexSubscriptionAccount(input) },
    }));
  }

  /** `codex:home:<sharedHomePath>` — the conversation home; identical across account switches. */
  continuationKey(input: { authAccount?: string }): string {
    return codexSubscriptionHome(input).continuationKey;
  }

  /**
   * The shadow-home materialization: mkdir + symlink ops from the pure
   * plan (@shiba/shared codex-home). Runs through the adapter's setup
   * allowlist in the configure phase, before config files land.
   */
  setupCommands(input: CodingTaskInput): readonly (readonly string[])[] {
    const layout = codexSubscriptionHome(input);
    // The sandbox home starts empty — no extra shared entries to observe;
    // the plan's link set is the known-shared list (private/shadow-local
    // names are refused a link by construction inside codexShadowHomeOps).
    return codexShadowHomeOps(layout).map((op) =>
      op.op === "mkdir"
        ? (["mkdir", "-p", op.path] as const)
        : (["ln", "-sfn", op.target, op.link] as const),
    );
  }

  /** Stub auth.json + config.toml in the directory CODEX_HOME points at — real files, never links. */
  configFile(input: CodingTaskInput): HarnessConfigFile[] {
    const homeDir = codexSubscriptionHomeDir(input);
    return [codexSubscriptionAuthFile(homeDir), codexSubscriptionConfigToml(homeDir)];
  }

  env(input: CodingTaskInput): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return {
      // Isolate via CODEX_HOME. No OPENAI_API_KEY at all — a real-looking
      // key would flip the CLI into API-key mode and the stub auth.json
      // keeps it in chatgpt mode.
      CODEX_HOME: codexSubscriptionHomeDir(input),
      CODEX_DISABLE_TELEMETRY: "1",
    };
  }

  buildArgv(input: CodingTaskInput, workdir: string): string[] {
    // Identical shape to codex: `codex exec --json --model <m> --cd <dir> <task>`;
    // the parser is reused verbatim.
    return [
      "codex",
      "exec",
      "--json",
      "--model",
      stripProvider(input.codingModel),
      "--cd",
      workdir,
      input.task,
    ];
  }

  parseEvent(line: string): HarnessEvent | null {
    try {
      return parseCodexEvent(line);
    } catch (error) {
      if (error instanceof CodexErrorEvent && /usage|rate.?limit|quota/i.test(error.detail)) {
        throw new CodexUsageLimitError(error.detail);
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
      execAllowlist: [["pnpm", "test"], ["npm", "test"], ["bun", "test"], ["pnpm", "vitest", "run"], ["npx", "vitest", "run"]],
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

export const codexSubscriptionHarness = new CodexSubscriptionHarness();
