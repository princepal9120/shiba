/**
 * `cursor-subscription` harness — the Cursor Agent CLI (`cursor-agent` in
 * ACP mode) running under the operator's own Cursor subscription key.
 *
 * Mirrors claude-subscription: a distinct harness name and provider
 * namespace (`cursor-subscription/<model>`) so a run can never mix the
 * subscription credential with a gateway BYOK model string. The container
 * holds a dummy CURSOR_API_KEY; the Worker's egress swaps the real
 * CURSOR_SUBSCRIPTION_TOKEN[_<ACCOUNT>] in on the two hosts the CLI calls
 * (api2.cursor.sh control plane, repo2.cursor.sh repo backend) — the
 * dedicated branch, never the gateway path.
 *
 * The run requires a succeeded T47 auth flow (see auth/instanceId): the
 * admission gate refuses a run whose account never began, whose probe
 * failed, or which was cleared — sign-out makes the harness unselectable
 * without touching selection code.
 */
import type { CodingTaskInput, CodingTaskResult } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import {
  assertSupportedModel,
  type AgentHarness,
  type HarnessConfigFile,
  type HarnessCapabilities,
  type HarnessEvent,
  type VerificationOutcome,
  verifyRunOutcome,
} from "./types.js";
import {
  CURSOR_DRIVER_SOURCE,
  CURSOR_EGRESS_HOSTS,
  cursorDriverPath,
  parseCursorEvent,
} from "./cursor.js";

/** Own provider namespace — `cursor-subscription/<model>` never collides with gateway `cursor/`. */
export const CURSOR_SUBSCRIPTION_PROVIDERS = ["cursor-subscription"] as const;

/** Account selector carried on the task envelope; "default" → CURSOR_SUBSCRIPTION_TOKEN. */
export function cursorSubscriptionAccount(input: CodingTaskInput): string {
  return input.authAccount ?? "default";
}

/** The T47 instanceId for an account — stable, never the credential. */
export function cursorSubscriptionInstanceId(input: CodingTaskInput): string {
  return `cursor-sub:${cursorSubscriptionAccount(input)}`;
}

export class CursorSubscriptionHarness implements AgentHarness {
  readonly name = "cursor-subscription" as const;
  readonly supportedProviders = CURSOR_SUBSCRIPTION_PROVIDERS;

  /** The run requires a succeeded T47 flow for this instance. */
  readonly auth = { instanceId: cursorSubscriptionInstanceId };

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return [...CURSOR_EGRESS_HOSTS];
  }

  /**
   * The subscription branch owns both Cursor hosts — repo2.cursor.sh has no
   * static handler at all and api2.cursor.sh's is the BYOK API-key path.
   * Params carry the account name, never the token.
   */
  egressOverrides(input: CodingTaskInput) {
    const account = cursorSubscriptionAccount(input);
    return CURSOR_EGRESS_HOSTS.map((host) => ({
      host,
      handler: "cursorSubscription",
      params: { account },
    }));
  }

  /** The same ACP driver the BYOK cursor harness writes — the run config is embedded as JSON. */
  configFile(input: CodingTaskInput, sandboxId: string): HarnessConfigFile {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    const model = stripProvider(input.codingModel);
    const run = { model: model === "auto" ? null : model, task: input.task };
    return {
      path: cursorDriverPath(sandboxId),
      contents: `"use strict";\nconst cfg = ${JSON.stringify(run)};\n${CURSOR_DRIVER_SOURCE}`,
    };
  }

  /** Dummy key only — the real token is attached by the egress handler. */
  env(input: CodingTaskInput, _configPath: string | null = null): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return { CURSOR_API_KEY: DUMMY_PROVIDER_KEY };
  }

  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    return ["node", cursorDriverPath(input.sandboxId)];
  }

  parseEvent(line: string): HarnessEvent | null {
    return parseCursorEvent(line);
  }

  /** Same surface as cursor, but declared runnable: the image ships cursor-agent (Dockerfile pin). */
  capabilities(_model?: string): HarnessCapabilities {
    return {
      streamsText: true,
      emitsToolCalls: true,
      supportsResume: false,
      supportsSteering: false,
      supportsFileAttachments: false,
      canRunTests: false,
      supportsConversationRollback: false,
      execAllowlist: [],
      supportedRuntimes: ["sandbox"],
    };
  }

  /** Deterministic outcome check — gates the completed claim. */
  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

/** The CLI takes a bare model id; the `provider/` prefix is ours. */
function stripProvider(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const cursorSubscriptionHarness = new CursorSubscriptionHarness();
