/**
 * ACP harness lanes (PLAN-V2-NEXT): every registry-listed ACP agent runs in
 * the sandbox through the shared driver. Covers the harness contract —
 * argv/env/configFile/parseEvent/egress — plus the registry wiring:
 * compatibleHarnesses must admit the lanes and HARNESS_MODEL_ENV must point
 * each at its provider's model var.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACP_ALLOW_PICK_SOURCE,
  AcpErrorEvent,
  AcpEventError,
  AcpHarness,
  acpDriverPath,
  parseAcpDriverEvent,
} from "../src/harness/acp.js";
import {
  ACP_LANES,
  HARNESS_DEFAULT_MODELS,
  HARNESS_MODEL_ENV,
  HARNESSES,
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

  it("the emitted driver is a syntactically valid Node program", () => {
    // The driver ships inside a template literal — string assertions can't
    // catch a syntax break, but `node --check` on the emitted file can.
    const input = task("anthropic/claude-sonnet-4-6");
    const config = claudeAcp.configFile(input, input.sandboxId);
    const files = Array.isArray(config) ? config : config === null ? [] : [config];
    const driver = files.find((f) => f.path === acpDriverPath(input.sandboxId));
    expect(driver).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "acp-driver-"));
    const driverPath = join(dir, "driver.cjs");
    writeFileSync(driverPath, driver!.contents);
    expect(() => execFileSync(process.execPath, ["--check", driverPath])).not.toThrow();
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

describe("per-lane spec hooks (ce-code-review fixes)", () => {
  it("devin-acp egress includes the codeium inference host, not just api.devin.ai", () => {
    const hosts = resolveHarness("devin-acp").egressHosts("devin/swe-2-medium");
    expect(hosts).toEqual(expect.arrayContaining(["api.devin.ai", "server.codeium.com"]));
  });

  it("devin-acp materializes credentials.toml and XDG_DATA_HOME like the devin lane", () => {
    const devinAcp = resolveHarness("devin-acp");
    const input = task("devin/swe-2-medium");
    const config = devinAcp.configFile(input, input.sandboxId);
    const files = Array.isArray(config) ? config : config === null ? [] : [config];
    const creds = files.find((f) => f.path.endsWith("/devin/credentials.toml"));
    expect(creds?.contents).toContain('api_server_url = "https://server.codeium.com"');
    expect(creds?.contents).toContain('windsurf_api_key = "dummy-egress-swapped"');
    expect(files.some((f) => f.path === acpDriverPath(input.sandboxId))).toBe(true);
    expect(devinAcp.env(input, files[0]?.path ?? null)).toMatchObject({
      XDG_DATA_HOME: "/workspace/.xdg-data",
      DEVIN_API_KEY: DUMMY_PROVIDER_KEY,
    });
  });

  it("opencode-acp passes provider/model through — OpenCode's ACP grammar needs the prefix", () => {
    const opencodeAcp = resolveHarness("opencode-acp");
    const input = task("google/gemini-3.5-flash-lite");
    const config = opencodeAcp.configFile(input, input.sandboxId);
    const files = Array.isArray(config) ? config : config === null ? [] : [config];
    const driver = files.find((f) => f.path === acpDriverPath(input.sandboxId));
    expect(driver?.contents).toContain('"google/gemini-3.5-flash-lite"');
    // The agent's own opencode.json ships too (enabled_providers + dummy key).
    const ocConfig = files.find((f) => f.path.endsWith(".opencode.json"));
    expect(ocConfig?.contents).toContain('"enabled_providers"');
    expect(opencodeAcp.env(input, ocConfig?.path ?? null)).toMatchObject({
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    });
    expect(opencodeAcp.env(input, ocConfig?.path ?? null).OPENCODE_CONFIG).toBe(ocConfig?.path);
  });

  it("default lanes still strip the provider prefix", () => {
    const config = claudeAcp.configFile(task("anthropic/claude-sonnet-4-6"), "sbx");
    const contents = Array.isArray(config) ? config[config.length - 1]!.contents : config?.contents;
    expect(contents).toContain('"claude-sonnet-4-6"');
    expect(contents).not.toContain('"anthropic/claude-sonnet-4-6"');
  });
});

describe("ACP_LANES single-source (Y2)", () => {
  it("derives the registry entries from the lane table — key is the harness name", () => {
    for (const [name, lane] of Object.entries(ACP_LANES)) {
      const harness = HARNESSES[name];
      expect(harness).toBeInstanceOf(AcpHarness);
      expect(harness?.name).toBe(name);
      // spawn argv + providers are the lane spec's own fields.
      expect(harness?.buildArgv(task("anthropic/claude-sonnet-4-6"), "/w")[0]).toBe("node");
      expect(harness?.supportedProviders).toEqual(lane.spec.providers);
    }
    // Every ACP-shaped registry name comes from the table — no hand-mirrors.
    expect(Object.keys(ACP_LANES).sort()).toEqual([...ACP_NAMES].sort());
  });

  it("derives the default model and model env var from the lane's mirrorOf", () => {
    for (const [name, lane] of Object.entries(ACP_LANES)) {
      expect(HARNESS_DEFAULT_MODELS[name]).toBe(HARNESS_DEFAULT_MODELS[lane.mirrorOf]);
      expect(HARNESS_MODEL_ENV[name as keyof typeof HARNESS_MODEL_ENV]).toBe(
        HARNESS_MODEL_ENV[lane.mirrorOf],
      );
    }
    expect(HARNESS_DEFAULT_MODELS["opencode-acp"]).toBe("google/gemini-3.5-flash-lite");
    expect(HARNESS_DEFAULT_MODELS["devin-acp"]).toBe("devin/swe-2-medium");
  });
});

describe("permission auto-allow picks the narrowest grant (C8)", () => {
  // The picker is plain CJS interpolated into the driver — evaluate the same
  // source the driver runs.
  const pick = new Function(`return (${ACP_ALLOW_PICK_SOURCE});`)() as (
    opts: { optionId: string; kind?: string }[],
  ) => { optionId: string } | null;

  it("prefers a single-use allow over allow_always regardless of option order", () => {
    const options = [
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ];
    expect(pick(options)?.optionId).toBe("allow-once");
    expect(pick([...options].reverse())?.optionId).toBe("allow-once");
  });

  it("falls back to a generic allow, then any allow, else nothing", () => {
    expect(pick([{ optionId: "yes", kind: "allow" }, { optionId: "aa", kind: "allow_always" }])?.optionId).toBe("yes");
    // An always grant is picked only when nothing narrower exists.
    expect(pick([{ optionId: "reject-once", kind: "reject_once" }, { optionId: "aa", kind: "allow_always" }])?.optionId).toBe("aa");
    expect(pick([{ optionId: "r1", kind: "reject_once" }])).toBeNull();
    expect(pick([])).toBeNull();
  });

  it("the emitted driver embeds the picker verbatim — no drift", () => {
    const input = task("anthropic/claude-sonnet-4-6");
    const config = claudeAcp.configFile(input, input.sandboxId);
    const files = Array.isArray(config) ? config : config === null ? [] : [config];
    const driver = files.find((f) => f.path === acpDriverPath(input.sandboxId));
    expect(driver?.contents).toContain(ACP_ALLOW_PICK_SOURCE);
  });
});

describe("compatibleHarnesses excludes unrunnable harnesses", () => {
  it("antigravity and cursor declare no sandbox runtime and are not advertised", () => {
    for (const service of ["google", "anthropic", "openai", "opencode-go", "devin", "cursor"] as const) {
      expect(compatibleHarnesses(service)).not.toContain("antigravity");
      expect(compatibleHarnesses(service)).not.toContain("cursor");
    }
    expect(compatibleHarnesses("google")).not.toEqual([]);
  });
});
