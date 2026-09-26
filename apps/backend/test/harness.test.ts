import { describe, expect, it } from "vitest";
import { ClaudeCodeErrorEvent, claudeCodeHarness, parseClaudeCodeEvent } from "../src/harness/claude-code.js";
import { CodexErrorEvent, codexHarness, parseCodexEvent } from "../src/harness/codex.js";
import { DevinErrorEvent, devinHarness, parseDevinEvent } from "../src/harness/devin.js";
import { agentCliCatalog } from "../src/harness/catalog.js";
import { allowedHostsFor, HARNESS_DEFAULT_MODELS, resolveHarness, resolveRunHarness } from "../src/harness/index.js";
import { opencodeHarness } from "../src/harness/opencode.js";
import { providerOf } from "../src/harness/types.js";
import { createRuntimeAdapter } from "../src/runtime.js";
import type { CodingTaskInput } from "../src/opencode-input.js";

const BASE: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

const input = (codingModel: string): CodingTaskInput => ({ ...BASE, codingModel });

describe("harness registry (T22)", () => {
  it("defaults to OpenCode and resolves each harness by name", () => {
    expect(resolveHarness(undefined).name).toBe("opencode");
    expect(resolveHarness("").name).toBe("opencode");
    expect(resolveHarness("claude-code").name).toBe("claude-code");
    expect(resolveHarness("CODEX").name).toBe("codex");
  });

  it("refuses an unknown harness by name", () => {
    expect(() => resolveHarness("aider")).toThrow(/Unknown agent harness/);
  });
});

describe("the selected harness reaches the adapter that runs it", () => {
  it("runs the harness AGENT_HARNESS selected, not the default", async () => {
    const execs: string[] = [];
    const adapter = createRuntimeAdapter("sandbox", resolveHarness("codex"));
    const ops = {
      gitCheckout: async () => {},
      writeFile: async () => { throw new Error("codex writes no config file"); },
      exec: async (command: string) => {
        execs.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async () => ({ kind: "utf8" as const, content: "" }),
    };
    await adapter.runCodingTask(ops, input("openai/gpt-5"), async () => {});
    // The agent invocation is the first exec; anything starting "opencode"
    // means the selection was dropped and egress would block its provider.
    expect(execs[0]).toMatch(/^'codex' 'exec'/);
    expect(execs[0]).not.toMatch(/opencode/);
  });
});

describe("per-run harness selection end to end", () => {
  it("the approved input's harness wins over the AGENT_HARNESS deploy default", () => {
    expect(resolveRunHarness("codex", "opencode").name).toBe("codex");
    expect(resolveRunHarness(undefined, "claude-code").name).toBe("claude-code");
    expect(resolveRunHarness("", "").name).toBe("opencode");
    expect(resolveRunHarness("  ", "codex").name).toBe("codex");
    expect(() => resolveRunHarness("aider", undefined)).toThrow(/Unknown agent harness/);
  });

  it("the child runs the harness the approved input named, not the env default", async () => {
    const execs: string[] = [];
    // What the orchestrator froze into the delegation input after the human
    // approved "codex" on a deployment whose AGENT_HARNESS is unset.
    const approved = { ...input("openai/gpt-5.3-codex"), harness: "codex" as const };
    const harness = resolveRunHarness(approved.harness, undefined);
    const adapter = createRuntimeAdapter("sandbox", harness);
    const ops = {
      gitCheckout: async () => {},
      writeFile: async () => { throw new Error("codex writes no config file"); },
      exec: async (command: string) => { execs.push(command); return { stdout: "", stderr: "", exitCode: 0 }; },
      readFile: async () => ({ kind: "utf8" as const, content: "" }),
    };
    await adapter.runCodingTask(ops, approved, async () => {});
    expect(execs[0]).toMatch(/^'codex' 'exec'/);
    expect(execs[0]).toContain("gpt-5.3-codex");
  });

  it("an unsupported provider for the approved harness fails at approval, not exec", () => {
    // The orchestrator runs allowedHostsFor before the sandbox starts.
    expect(() => allowedHostsFor(resolveRunHarness("claude-code", undefined), "openai/gpt-5.4")).toThrow(/supports anthropic/);
    // The claude-code default model is anthropic/* and passes.
    expect(allowedHostsFor(resolveRunHarness("claude-code", undefined), HARNESS_DEFAULT_MODELS["claude-code"] as string)).toContain("api.anthropic.com");
  });
});

describe("provider validation (T23 fixes B11)", () => {
  it("reads the provider off a provider/model id", () => {
    expect(providerOf("google/gemini-3.5-flash-lite")).toBe("google");
    expect(providerOf("gemini-3.5-flash-lite")).toBeNull();
    expect(providerOf("/leading")).toBeNull();
    expect(providerOf("trailing/")).toBeNull();
  });

  it("lets OpenCode drive a non-google provider — the lock-in is gone", () => {
    const config = opencodeHarness.buildConfig(input("anthropic/claude-opus-5"));
    expect(config.enabled_providers).toEqual(["anthropic"]);
  });

  it("routes Grok (xAI) through OpenCode with an isolated xAI egress host", () => {
    expect(opencodeHarness.egressHosts("xai/grok-4")).toEqual(["api.x.ai"]);
    expect(opencodeHarness.buildConfig(input("xai/grok-4")).enabled_providers).toEqual(["xai"]);
    expect(opencodeHarness.env(input("xai/grok-4"), null).XAI_API_KEY).toBe("shiba-ai-coworker-dummy-key");
    expect(allowedHostsFor(opencodeHarness, "xai/grok-4")).toContain("api.x.ai");
  });

  it("refuses a provider the selected harness cannot drive, naming what it supports", () => {
    expect(() => claudeCodeHarness.egressHosts("openai/gpt-5")).toThrow(/supports anthropic/);
    expect(() => codexHarness.egressHosts("anthropic/claude-opus-5")).toThrow(/supports openai/);
    expect(() => opencodeHarness.egressHosts("mistral/large")).toThrow(/supports google, anthropic, openai, xai/);
  });
});

describe("egress hosts are per selected harness, never the union (T5 + T22)", () => {
  it("allows only the chosen harness's provider host plus git", () => {
    expect(allowedHostsFor(opencodeHarness, "google/gemini-3.5-flash-lite")).toEqual([
      "generativelanguage.googleapis.com", "github.com", "codeload.github.com",
    ]);
    expect(allowedHostsFor(claudeCodeHarness, "anthropic/claude-opus-5")).toEqual([
      "api.anthropic.com", "github.com", "codeload.github.com",
    ]);
    expect(allowedHostsFor(codexHarness, "openai/gpt-5")).toEqual([
      "api.openai.com", "github.com", "codeload.github.com",
    ]);
  });

  it("never leaks another harness's host into the allowlist", () => {
    const hosts = allowedHostsFor(claudeCodeHarness, "anthropic/claude-opus-5");
    expect(hosts).not.toContain("generativelanguage.googleapis.com");
    expect(hosts).not.toContain("api.openai.com");
  });

  it("follows the provider, not just the harness", () => {
    expect(allowedHostsFor(opencodeHarness, "openai/gpt-5")).toContain("api.openai.com");
    expect(allowedHostsFor(opencodeHarness, "openai/gpt-5")).not.toContain("generativelanguage.googleapis.com");
  });
});

describe("the container never receives a real credential", () => {
  it.each([
    [opencodeHarness, "google/gemini-3.5-flash-lite", "GOOGLE_GENERATIVE_AI_API_KEY"],
    [opencodeHarness, "anthropic/claude-opus-5", "ANTHROPIC_API_KEY"],
    [claudeCodeHarness, "anthropic/claude-opus-5", "ANTHROPIC_API_KEY"],
    [codexHarness, "openai/gpt-5", "OPENAI_API_KEY"],
  ])("%# passes only the dummy key", (harness, model, keyVar) => {
    const env = harness.env(input(model), null);
    expect(env[keyVar]).toBe("shiba-ai-coworker-dummy-key");
    for (const value of Object.values(env)) {
      expect(value).not.toMatch(/sk-|ghp_|AIza/);
    }
  });
});

describe("OpenCode output is unchanged by the T22 widening", () => {
  it("pins argv byte for byte", () => {
    expect(opencodeHarness.buildArgv(BASE, "/workspace/x")).toEqual([
      "opencode", "run", "--format", "json",
      "--model", "google/gemini-3.5-flash-lite",
      "--dir", "/workspace/x", "Fix it.",
    ]);
  });

  it("pins the config file path and contents", () => {
    const config = opencodeHarness.configFile(BASE, BASE.sandboxId);
    expect(config?.path).toBe("/workspace/run-abcdef12345678.opencode.json");
    expect(JSON.parse(config?.contents ?? "{}")).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "google/gemini-3.5-flash-lite",
      enabled_providers: ["google"],
      autoupdate: false,
      provider: { google: { options: { apiKey: "shiba-ai-coworker-dummy-key" } } },
    });
  });

  it("pins the container env", () => {
    expect(opencodeHarness.env(BASE, "/workspace/cfg.json")).toEqual({
      OPENCODE_CONFIG: "/workspace/cfg.json",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      GOOGLE_GENERATIVE_AI_API_KEY: "shiba-ai-coworker-dummy-key",
    });
  });
});

describe("claude-code harness (T22)", () => {
  it("invokes headlessly with the bare model id and writes no config file", () => {
    expect(claudeCodeHarness.configFile()).toBeNull();
    expect(claudeCodeHarness.buildArgv(input("anthropic/claude-opus-5"), "/workspace/x")).toEqual([
      "claude", "--print", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "acceptEdits",
      "--model", "claude-opus-5", "--add-dir", "/workspace/x", "Fix it.",
    ]);
  });

  it("surfaces assistant text and tool calls as progress", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Editing src/a.ts" }, { type: "tool_use", name: "Edit" }] },
    });
    expect(parseClaudeCodeEvent(line)).toBe("Editing src/a.ts tool: Edit");
    expect(parseClaudeCodeEvent("   ")).toBeNull();
  });

  it("throws on an error result rather than reporting success", () => {
    const line = JSON.stringify({ type: "result", is_error: true, result: "rate limited" });
    expect(() => parseClaudeCodeEvent(line)).toThrow(ClaudeCodeErrorEvent);
    expect(() => parseClaudeCodeEvent("not json")).toThrow(/Unparseable Claude Code event/);
  });
});

describe("codex harness (T22)", () => {
  it("invokes exec with the bare model id and writes no config file", () => {
    expect(codexHarness.configFile()).toBeNull();
    expect(codexHarness.buildArgv(input("openai/gpt-5"), "/workspace/x")).toEqual([
      "codex", "exec", "--json", "--model", "gpt-5", "--cd", "/workspace/x", "Fix it.",
    ]);
  });

  it("throws on an error envelope rather than reporting success", () => {
    expect(() => parseCodexEvent(JSON.stringify({ type: "error", message: "boom" }))).toThrow(CodexErrorEvent);
    expect(() => parseCodexEvent("[1,2]")).toThrow(/not an object/);
    expect(parseCodexEvent("")).toBeNull();
  });
});

describe("devin harness", () => {
  it("resolves by name and defaults to the free swe-2 model", () => {
    expect(resolveHarness("devin").name).toBe("devin");
    expect(resolveHarness("DEVIN").name).toBe("devin");
    expect(HARNESS_DEFAULT_MODELS.devin).toBe("devin/swe-2");
  });

  it("runs headless with the bare model alias and bypass inside the sandbox", () => {
    expect(devinHarness.buildArgv(input("devin/swe-2"), "/workspace/x")).toEqual([
      "devin", "-p", "--model", "swe-2",
      "--permission-mode", "bypass",
      "--respect-workspace-trust", "false",
      "--", "Fix it.",
    ]);
  });

  it("writes a dummy credentials.toml under the container XDG dir", () => {
    const file = devinHarness.configFile(input("devin/swe-2"), "run-x");
    expect(file).not.toBeNull();
    expect(file?.path).toBe("/workspace/.xdg-data/devin/credentials.toml");
    expect(file?.contents).toContain('windsurf_api_key = "dummy-egress-swapped"');
    expect(file?.contents).toContain('devin_api_url = "https://api.devin.ai"');
    expect(file?.contents).not.toMatch(/devin-key-secret|sk-/);
  });

  it("gets a dummy env key and redirects XDG_DATA_HOME", () => {
    const env = devinHarness.env(input("devin/swe-2"), "/workspace/.xdg-data/devin/credentials.toml");
    expect(env.XDG_DATA_HOME).toBe("/workspace/.xdg-data");
    expect(env.DEVIN_API_KEY).toBeTruthy();
    expect(env.DEVIN_API_KEY).not.toContain("devin-key-secret");
  });

  it("narrows egress to both Devin hosts plus git — never the provider union", () => {
    expect(devinHarness.egressHosts("devin/swe-2")).toEqual(["api.devin.ai", "server.codeium.com"]);
    expect(allowedHostsFor(devinHarness, "devin/swe-2")).toEqual([
      "api.devin.ai",
      "server.codeium.com",
      "github.com",
      "codeload.github.com",
    ]);
  });

  it("refuses non-devin models and providerless ids", () => {
    expect(() => devinHarness.buildArgv(input("google/gemini-3.5-flash-lite"), "/x")).toThrow(/devin harness supports/);
    expect(() => devinHarness.buildArgv(input("swe-2"), "/x")).toThrow(/provider\/model/);
  });

  it("passes plain-text lines through and drops the login banner", () => {
    expect(parseDevinEvent("Editing src/a.ts")).toBe("Editing src/a.ts");
    expect(parseDevinEvent("   ")).toBeNull();
    expect(parseDevinEvent("Welcome to Devin CLI!")).toBeNull();
    expect(parseDevinEvent(" ✓ Logged in as someone@example.com.")).toBeNull();
  });

  it("throws on auth failures rather than reporting success", () => {
    expect(() => parseDevinEvent("Not logged in.")).toThrow(DevinErrorEvent);
    expect(() => parseDevinEvent("Login failed. Browser auth error")).toThrow(DevinErrorEvent);
  });
});

describe("agent cli catalog", () => {
  it("lists every registered harness with its pinned version", () => {
    const catalog = agentCliCatalog({});
    expect(catalog.map((a) => a.id)).toEqual(["opencode", "claude-code", "codex", "cursor", "devin", "grok"]);
    expect(catalog.find((a) => a.id === "cursor")?.version).toBe("0.50.0");
    expect(catalog.find((a) => a.id === "grok")?.version).toBe("0.1.0");
    expect(catalog.find((a) => a.id === "devin")?.version).toBe("3000.10.31");
    expect(catalog.find((a) => a.id === "devin")?.defaultModel).toBe("devin/swe-2");
  });

  it("reports devin's secret presence without exposing the value", () => {
    const unset = agentCliCatalog({}).find((a) => a.id === "devin");
    expect(unset?.credential.configured).toBe(false);
    expect(unset?.credential.setupHint).toContain("DEVIN_API_KEY");
    const set = agentCliCatalog({ DEVIN_API_KEY: "real-secret" }).find((a) => a.id === "devin");
    expect(set?.credential.configured).toBe(true);
    expect(JSON.stringify(set)).not.toContain("real-secret");
  });

  it("marks gateway-backed harnesses as not introspectable", () => {
    const opencode = agentCliCatalog({}).find((a) => a.id === "opencode");
    expect(opencode?.credential.kind).toBe("ai-gateway-byok");
    expect(opencode?.credential.configured).toBeNull();
  });
});
