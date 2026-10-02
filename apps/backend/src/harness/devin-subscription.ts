/**
 * `devin-subscription` harness — the Devin CLI running under the operator's
 * own Devin account key rather than the deployment-wide DEVIN_API_KEY.
 *
 * Mirrors claude-subscription: a distinct harness name and provider
 * namespace (`devin-subscription/<model-alias>`) so a run can never mix the
 * subscription credential with a gateway model string. The container holds
 * a dummy credentials.toml; the Worker's egress swaps the real
 * DEVIN_SUBSCRIPTION_TOKEN[_<ACCOUNT>] in on the two hosts the CLI calls
 * (api.devin.ai control plane, server.codeium.com inference backend) — the
 * dedicated subscription branch, never the deployment API-key path.
 *
 * The run requires a succeeded T47 auth flow (see auth/instanceId): the
 * admission gate refuses a run whose account never began, whose probe
 * failed, or which was cleared.
 */
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import {
  assertSupportedModel,
  PROVIDER_KEY_ENV,
  type AgentHarness,
  type HarnessConfigFile,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import { DEVIN_EGRESS_HOSTS, parseDevinEvent } from "./devin.js";

/** Own provider namespace — `devin-subscription/<alias>` never collides with `devin/`. */
export const DEVIN_SUBSCRIPTION_PROVIDERS = ["devin-subscription"] as const;

/** XDG_DATA_HOME inside the container; credentials.toml lands under it. Same layout as devin. */
const CONTAINER_XDG_DATA = "/workspace/.xdg-data";

/** Account selector carried on the task envelope; "default" → DEVIN_SUBSCRIPTION_TOKEN. */
export function devinSubscriptionAccount(input: CodingTaskInput): string {
  return input.authAccount ?? "default";
}

/** The T47 instanceId for an account — stable, never the credential. */
export function devinSubscriptionInstanceId(input: CodingTaskInput): string {
  return `devin-sub:${devinSubscriptionAccount(input)}`;
}

export class DevinSubscriptionHarness implements AgentHarness {
  readonly name = "devin-subscription" as const;
  readonly supportedProviders = DEVIN_SUBSCRIPTION_PROVIDERS;

  /** The run requires a succeeded T47 flow for this instance. */
  readonly auth = { instanceId: devinSubscriptionInstanceId };

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return [...DEVIN_EGRESS_HOSTS];
  }

  /**
   * The subscription branch owns both Devin hosts — their static handlers
   * are the deployment-wide DEVIN_API_KEY path. Params carry the account
   * name, never the token.
   */
  egressOverrides(input: CodingTaskInput) {
    const account = devinSubscriptionAccount(input);
    return DEVIN_EGRESS_HOSTS.map((host) => ({
      host,
      handler: "devinSubscription",
      params: { account },
    }));
  }

  /** Dummy credentials file — identical layout to devin; the egress forwarder overwrites auth. */
  configFile(_input: CodingTaskInput, _sandboxId: string): HarnessConfigFile {
    return {
      path: CONTAINER_XDG_DATA + "/devin/credentials.toml",
      contents: [
        'windsurf_api_key = "dummy-egress-swapped"',
        'api_server_url = "https://server.codeium.com"',
        'devin_webapp_host = "https://app.devin.ai"',
        'devin_api_url = "https://api.devin.ai"',
        "",
      ].join("\n"),
    };
  }

  env(input: CodingTaskInput, _configPath: string | null): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return {
      XDG_DATA_HOME: CONTAINER_XDG_DATA,
      [PROVIDER_KEY_ENV["devin-subscription"] as string]: DUMMY_PROVIDER_KEY,
    };
  }

  /** Headless single-turn run — identical argv to the devin harness. */
  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return [
      "devin",
      "-p",
      "--model",
      input.codingModel.slice("devin-subscription/".length),
      "--permission-mode",
      "bypass",
      "--respect-workspace-trust",
      "false",
      "--",
      input.task,
    ];
  }

  parseEvent(line: string): HarnessEvent | null {
    return parseDevinEvent(line);
  }

  /** Same capability surface as devin — sandbox-runnable, resumable, can run the T45 gate. */
  capabilities(_model?: string): HarnessCapabilities {
    return {
      streamsText: true,
      emitsToolCalls: false,
      supportsResume: true,
      supportsSteering: false,
      supportsFileAttachments: false,
      canRunTests: true,
      supportsConversationRollback: false,
      execAllowlist: [["pnpm", "test"], ["npm", "test"], ["bun", "test"], ["pnpm", "vitest", "run"], ["npx", "vitest", "run"]],
      supportedRuntimes: ["sandbox"],
    };
  }

  /** Deterministic outcome check — gates the completed claim. */
  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

export const devinSubscriptionHarness = new DevinSubscriptionHarness();
