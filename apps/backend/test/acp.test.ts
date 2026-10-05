/**
 * ACP harness lanes (PLAN-V2-NEXT): every registry-listed ACP agent runs in
 * the sandbox through the shared driver. Covers the harness contract —
 * argv/env/configFile/parseEvent/egress — plus the registry wiring:
 * compatibleHarnesses must admit the lanes and HARNESS_MODEL_ENV must point
 * each at its provider's model var.
 */
import { describe, expect, it } from "vitest";
import {
  AcpErrorEvent,
  AcpEventError,
  AcpHarness,
  acpDriverPath,
  parseAcpDriverEvent,
} from "../src/harness/acp.js";
import {
  HARNESS_DEFAULT_MODELS,
  HARNESS_MODEL_ENV,
  resolveHarness,
  resolveRunHarness,
} from "../src/harness/index.js";
import { DUMMY_PROVIDER_KEY } from "../src/provider-gateway.js";
import { PROVIDER_HOSTS } from "../src/harness/types.js";
import { compatibleHarnesses } from "../src/model-connections.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const ACP_NAMES = ["claude-acp", "codex-acp", "gemini-acp", "opencode-acp", "devin-acp"] as const;

const task = (codingModel: string): CodingTaskInput => ({
  repoUrl: "https://github.com/owner/repo",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-acp12345",
  codingModel,
});

const claudeAcp = resolveHarness("claude-acp");

describe("ACP registry lanes", () => {
  it("every ACP name resolves to an AcpHarness admitted to the sandbox gate", () => {
    for (const name of ACP_NAMES) {
      const harness = resolveHarness(name);
      expect(harness).toBeInstanceOf(AcpHarness);
      expect(harness.name).toBe(name);
      expect(harness.capabilities().supportedRuntimes).toContain("sandbox");
      expect(HARNESS_DEFAULT_MODELS[name]).toMatch(/^[\w.-]+\/[\w.-]+/);
    }
  });

  it("per-run selection picks the ACP lane by name", () => {
    expect(resolveRunHarness("codex-acp", "opencode").name).toBe("codex-acp");
  });

  it("ACP lanes ride their provider's deployment model var — no new env vars", () => {
    expect(HARNESS_MODEL_ENV["claude-acp"]).toBe("CLAUDE_CODE_MODEL");
    expect(HARNESS_MODEL_ENV["codex-acp"]).toBe("CODEX_MODEL");
    expect(HARNESS_MODEL_ENV["devin-acp"]).toBe("DEVIN_MODEL");
    expect(HARNESS_MODEL_ENV["gemini-acp"]).toBe("CODING_MODEL");
    expect(HARNESS_MODEL_ENV["opencode-acp"]).toBe("CODING_MODEL");
  });
});

describe("compatibleHarnesses admits ACP lanes by provider", () => {
  it("claude-acp for anthropic, codex-acp for openai, gemini-acp for google", () => {
    expect(compatibleHarnesses("anthropic")).toContain("claude-acp");
    expect(compatibleHarnesses("openai")).toContain("codex-acp");
    expect(compatibleHarnesses("google")).toEqual(
      expect.arrayContaining(["gemini-acp", "opencode-acp"]),
    );
    expect(compatibleHarnesses("devin")).toContain("devin-acp");
  });
});

describe("AcpHarness contract", () => {
  it("buildArgv runs the driver, configFile writes it at the deterministic path", () => {
    const input = task("anthropic/claude-sonnet-4-6");
    const config = claudeAcp.configFile(input, input.sandboxId);
    if (config === null || Array.isArray(config)) throw new Error("expected a single config file");
    expect(config.path).toBe(acpDriverPath(input.sandboxId));
    expect(config.path).toBe("/workspace/run-acp12345.acp-driver.cjs");
    expect(claudeAcp.buildArgv(input, "/workspace/repo")).toEqual([
      "node",
      acpDriverPath(input.sandboxId),
    ]);
    // The spawn spec and the stripped model are embedded in the driver source.
    expect(config.contents).toContain('"claude-agent-acp"');
    expect(config.contents).toContain('"claude-sonnet-4-6"');
    expect(config.contents).not.toContain('"anthropic/claude-sonnet-4-6"');
  });

  it("env hands the container the dummy key on the provider's standard var", () => {
    expect(claudeAcp.env(task("anthropic/claude-sonnet-4-6"), null)).toEqual({
      ANTHROPIC_API_KEY: DUMMY_PROVIDER_KEY,
    });
    expect(resolveHarness("codex-acp").env(task("openai/gpt-5.3-codex"), null)).toEqual({
      OPENAI_API_KEY: DUMMY_PROVIDER_KEY,
    });
    // gemini-cli listens on GEMINI_API_KEY, not the provider's standard var.
    expect(resolveHarness("gemini-acp").env(task("google/gemini-3.5-flash"), null)).toEqual({
      GEMINI_API_KEY: DUMMY_PROVIDER_KEY,
    });
  });

  it("egressHosts exposes only the model's provider host", () => {
    expect(claudeAcp.egressHosts("anthropic/claude-sonnet-4-6")).toEqual([
      PROVIDER_HOSTS["anthropic"],
    ]);
  });

  it("rejects a model outside the harness's providers", () => {
    expect(() => claudeAcp.configFile(task("openai/gpt-5.3-codex"), "sbx")).toThrow();
  });
});

describe("the ACP driver event parser", () => {
  it("parses a text update into a HarnessEvent", () => {
    expect(parseAcpDriverEvent('{"type":"agent_message_chunk","text":"hi"}', "Claude ACP")).toEqual({
      kind: "text",
      text: "hi",
    });
    expect(parseAcpDriverEvent('{"type":"plan","text":""}', "Claude ACP")).toBeNull();
    expect(parseAcpDriverEvent("   ", "Claude ACP")).toBeNull();
  });

  it("raises AcpErrorEvent on an agent-reported error and AcpEventError on garbage", () => {
    expect(() => parseAcpDriverEvent('{"type":"error","message":"boom"}', "Claude ACP")).toThrow(
      AcpErrorEvent,
    );
    expect(() => parseAcpDriverEvent("not json", "Claude ACP")).toThrow(AcpEventError);
    expect(() => parseAcpDriverEvent("[1,2]", "Claude ACP")).toThrow(AcpEventError);
  });
});
