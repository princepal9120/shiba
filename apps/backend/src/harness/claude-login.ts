/**
 * Compliant Claude subscription path: the unmodified `claude` binary runs in
 * the sandbox; the operator signs in via Anthropic's own `/login` flow.
 * Credentials live only under CLAUDE_CONFIG_DIR on a per-user persistent
 * volume — shiba never reads, copies, or exports them.
 *
 * Per-user persistent sandbox volumes are not wired yet (blocked on #119/#123).
 * This harness registers the env contract and documents the volume mount;
 * runs fail closed until the Sandbox SDK exposes user-scoped volumes.
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
import { parseClaudeCodeEvent } from "./claude-code.js";

export const CLAUDE_LOGIN_PROVIDERS = ["anthropic-subscription"] as const;

export interface ClaudeLoginVolumeMount {
  userId: string;
  hostPath: string;
  containerPath: string;
}

/** Stub until @shiba/sandbox exposes per-user persistent volumes (#119/#123). */
export function claudeLoginVolumeForUser(userId: string): ClaudeLoginVolumeMount | null {
  if (userId.trim() === "") return null;
  return {
    userId,
    hostPath: `/var/shiba/claude-config/${userId.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
    containerPath: `/root/.shiba/claude-login/${userId.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
  };
}

export function claudeLoginConfigDir(input: Pick<CodingTaskInput, "initiatorUserId">): string {
  const userId = input.initiatorUserId ?? "anonymous";
  const mount = claudeLoginVolumeForUser(userId);
  return mount?.containerPath ?? `/root/.shiba/claude-login/unprovisioned`;
}

export class ClaudeLoginHarness implements AgentHarness {
  readonly name = "claude-login" as const;
  readonly supportedProviders = CLAUDE_LOGIN_PROVIDERS;

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return ["api.anthropic.com"];
  }

  configFile(input: CodingTaskInput): HarnessConfigFile[] {
    return [];
  }

  env(input: CodingTaskInput): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return {
      CLAUDE_CONFIG_DIR: claudeLoginConfigDir(input),
    };
  }

  buildArgv(input: CodingTaskInput, workdir: string): string[] {
    const model = input.codingModel.includes("/") ? input.codingModel.split("/").slice(1).join("/") : input.codingModel;
    const effort = input.route?.reasoningEffort ? ["--effort", input.route.reasoningEffort] : [];
    return ["claude", "--print", "--model", model, ...effort, "--add-dir", workdir, input.task];
  }

  parseEvent(line: string): HarnessEvent | null {
    return parseClaudeCodeEvent(line);
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
      execAllowlist: [["pnpm", "test"], ["npm", "test"], ["bun", "test"]],
      supportedRuntimes: ["sandbox"],
    };
  }

  async verify(input: CodingTaskInput, result: CodingTaskResult): Promise<VerificationOutcome> {
    if (!input.initiatorUserId) {
      return { ok: false, reason: "claude-login requires a signed-in user (initiatorUserId)." };
    }
    if (claudeLoginVolumeForUser(input.initiatorUserId) === null) {
      return {
        ok: false,
        reason:
          "Per-user Claude config volumes are not available on this deployment yet (#119/#123). Use API-key claude-code or run claude /login manually in your sandbox.",
      };
    }
    return verifyRunOutcome(input, result, this.capabilities(input.codingModel));
  }
}

export const claudeLoginHarness = new ClaudeLoginHarness();
