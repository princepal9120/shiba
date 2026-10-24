import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeErrorEvent, claudeCodeHarness, parseClaudeCodeEvent } from "../src/harness/claude-code.js";
import { CodexErrorEvent, codexHarness, parseCodexEvent } from "../src/harness/codex.js";
import { GrokErrorEvent, grokHarness, parseGrokEvent } from "../src/harness/grok.js";
import { PiErrorEvent, PiEventError, parsePiEvent, piHarness } from "../src/harness/pi.js";
import { agentCliCatalog } from "../src/harness/catalog.js";
import { compatibleHarnesses } from "../src/model-connections.js";
import { allowedHostsFor, HARNESS_DEFAULT_MODELS, HARNESS_MODEL_ENV, resolveHarness, resolveRunHarness } from "../src/harness/index.js";
import { opencodeHarness, parseOpencodeEvent } from "../src/harness/opencode.js";
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
    expect(resolveHarness("pi").name).toBe("pi");
  });

  it("refuses an unknown harness by name", () => {
    expect(() => resolveHarness("aider")).toThrow(/Unknown agent harness/);
  });
});

describe("the selected harness reaches the adapter that runs it", () => {
  it("runs the harness AGENT_HARNESS selected, not the default", async () => {
    const execs: string[] = [];
    const files = new Map<string, string>();
    const adapter = createRuntimeAdapter("sandbox", resolveHarness("codex"));
    const ops = {
      gitCheckout: async () => {},
      writeFile: async (path: string, contents: string) => {
        if (!path.endsWith(".agent-harness.mjs") && !path.endsWith(".job.json")) {
          throw new Error("codex writes no config file");
        }
        files.set(path, contents);
      },
      exec: async (command: string) => {
        execs.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async () => ({ kind: "utf8" as const, content: "" }),
    };
    await adapter.runCodingTask(ops, input("openai/gpt-5"), async () => {});
    // The sandbox execs the session runner. The job names the selected
    // harness; an opencode command would mean the selection was dropped.
    const harnessExec = execs.find((command) => command.includes("agent-harness.mjs"));
    expect(harnessExec).toMatch(/^'node'/);
    expect(harnessExec).not.toMatch(/opencode/);
    const job = files.get("/workspace/run-abcdef12345678.job.json") ?? "";
    expect(job).toContain('"provider":"codex"');
    expect(job).toContain("gpt-5");
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
    const files = new Map<string, string>();
    // What the orchestrator froze into the delegation input after the human
    // approved "codex" on a deployment whose AGENT_HARNESS is unset.
    const approved = { ...input("openai/gpt-5.3-codex"), harness: "codex" as const };
    const harness = resolveRunHarness(approved.harness, undefined);
    const adapter = createRuntimeAdapter("sandbox", harness);
    const ops = {
      gitCheckout: async () => {},
      writeFile: async (path: string, contents: string) => {
        if (!path.endsWith(".agent-harness.mjs") && !path.endsWith(".job.json")) {
          throw new Error("codex writes no config file");
        }
        files.set(path, contents);
      },
      exec: async (command: string) => { execs.push(command); return { stdout: "", stderr: "", exitCode: 0 }; },
      readFile: async () => ({ kind: "utf8" as const, content: "" }),
    };
    await adapter.runCodingTask(ops, approved, async () => {});
    const harnessExec = execs.find((command) => command.includes("agent-harness.mjs"));
    expect(harnessExec).toMatch(/^'node'/);
    expect(files.get("/workspace/run-abcdef12345678.job.json")).toContain("gpt-5.3-codex");
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
    expect(opencodeHarness.egressHosts("xai/grok-4.6")).toEqual(["api.x.ai"]);
    expect(opencodeHarness.buildConfig(input("xai/grok-4.6")).enabled_providers).toEqual(["xai"]);
    expect(opencodeHarness.env(input("xai/grok-4.6"), null).XAI_API_KEY).toBe("shiba-dummy-key");
    expect(allowedHostsFor(opencodeHarness, "xai/grok-4.6")).toContain("api.x.ai");
  });

  it("supports Pi's four provider ids and their single-provider egress hosts", () => {
    for (const [model, host] of [
      ["anthropic/claude-sonnet-4-6", "api.anthropic.com"],
      ["openai/gpt-5.3-codex", "api.openai.com"],
      ["google/gemini-3.5-flash-lite", "generativelanguage.googleapis.com"],
      ["xai/grok-4.6", "api.x.ai"],
    ] as const) {
      expect(piHarness.egressHosts(model)).toEqual([host]);
      expect(allowedHostsFor(piHarness, model)).toEqual([host, "github.com", "codeload.github.com"]);
    }
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
    expect(env[keyVar]).toBe("shiba-dummy-key");
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
      provider: { google: { options: { apiKey: "shiba-dummy-key" } } },
    });
  });

  it("pins the container env", () => {
    expect(opencodeHarness.env(BASE, "/workspace/cfg.json")).toEqual({
      OPENCODE_CONFIG: "/workspace/cfg.json",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      GOOGLE_GENERATIVE_AI_API_KEY: "shiba-dummy-key",
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
    expect(parseClaudeCodeEvent(line)).toEqual({ kind: "tool", name: "Edit", text: "Editing src/a.ts tool: Edit" });
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

describe("usage reporting — only what a harness stream emits", () => {
  it("opencode step_finish folds cache+reasoning into a delta and keeps cost", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: {
        tokens: { input: 100, output: 40, reasoning: 5, cache: { read: 20, write: 3 } },
        cost: 0.0042,
      },
    });
    expect(parseOpencodeEvent(line)).toEqual({
      kind: "usage",
      usage: { inputTokens: 123, outputTokens: 45, costUsd: 0.0042 },
      text: "usage: 123 in / 45 out / $0.0042",
    });
  });

  it("opencode step_finish without token fields stays progress", () => {
    const event = parseOpencodeEvent(JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }));
    expect(event).toEqual({ kind: "progress", text: "step_finish" });
  });

  it("claude assistant envelopes emit the per-request usage delta alongside the text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Editing src/a.ts" }],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 2,
        },
      },
    });
    expect(parseClaudeCodeEvent(line)).toEqual({
      kind: "usage",
      cumulative: false,
      usage: { inputTokens: 18, outputTokens: 4 },
      text: "Editing src/a.ts",
    });
  });

  it("claude result envelopes carry the cumulative run usage and USD cost", () => {
    const line = JSON.stringify({
      type: "result",
      result: "done",
      usage: {
        input_tokens: 50,
        output_tokens: 9,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      total_cost_usd: 0.0123,
    });
    expect(parseClaudeCodeEvent(line)).toEqual({
      kind: "usage",
      cumulative: true,
      usage: { inputTokens: 65, outputTokens: 9, costUsd: 0.0123 },
      text: "done",
    });
    // A result without usage still reports as the terminal event.
    expect(parseClaudeCodeEvent(JSON.stringify({ type: "result", result: "done" })))
      .toEqual({ kind: "result", text: "done" });
  });

  it("codex turn.completed carries the turn's cumulative usage block", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 300,
        cached_input_tokens: 40,
        cache_write_input_tokens: 10,
        output_tokens: 90,
        reasoning_output_tokens: 30,
      },
    });
    expect(parseCodexEvent(line)).toEqual({
      kind: "usage",
      cumulative: true,
      usage: { inputTokens: 350, outputTokens: 120 },
      text: "usage: 350 in / 120 out",
    });
    // Without a usage block it stays progress, never fabricated.
    expect(parseCodexEvent(JSON.stringify({ type: "turn.completed" })))
      .toEqual({ kind: "progress", text: "turn.completed" });
  });
});

describe("grok harness", () => {
  it("runs headless --single mode with the bare model id on the api.x.ai forwarder", () => {
    expect(grokHarness.configFile()).toBeNull();
    expect(grokHarness.buildArgv(input("xai/grok-4.6"), "/workspace/x")).toEqual([
      "grok", "--single", "Fix it.",
      "--output-format", "streaming-json",
      "--permission-mode", "bypassPermissions",
      "--model", "grok-4.6",
      "--reasoning-effort", "medium",
      "--cwd", "/workspace/x",
    ]);
  });

  it("passes the dummy key and pins inference to api.x.ai — never cli-chat-proxy", () => {
    const env = grokHarness.env(input("xai/grok-4.6"), null);
    expect(env.XAI_API_KEY).toBe("shiba-dummy-key");
    expect(env.GROK_MODELS_BASE_URL).toBe("https://api.x.ai/v1");
    expect(grokHarness.egressHosts("xai/grok-4.6")).toEqual(["api.x.ai"]);
    expect(allowedHostsFor(grokHarness, "xai/grok-4.6")).toEqual([
      "api.x.ai", "github.com", "codeload.github.com",
    ]);
  });

  it("surfaces text and tool lines, drops the catalog/bootstrap lines", () => {
    expect(parseGrokEvent("   ")).toBeNull();
    expect(parseGrokEvent(JSON.stringify({ type: "available_commands", tools: ["a"], commands: ["b"] }))).toBeNull();
    expect(parseGrokEvent(JSON.stringify({ type: "tool_call_update", toolCallId: "c1", status: "completed" }))).toBeNull();
    expect(parseGrokEvent(JSON.stringify({ type: "usage", used: 10 }))).toBeNull();
    expect(parseGrokEvent(JSON.stringify({ type: "text", data: "Editing src/a.ts" }))).toEqual({ kind: "text", text: "Editing src/a.ts" });
    expect(parseGrokEvent(JSON.stringify({ type: "thought", data: "planning" }))).toEqual({ kind: "text", text: "planning" });
    expect(parseGrokEvent(JSON.stringify({
      type: "tool_call", toolCallId: "c1", title: "write", kind: "write", status: "in_progress",
    }))).toEqual({ kind: "tool", name: "write", text: "tool: write" });
  });

  it("throws on error and non-clean stop reasons rather than reporting success", () => {
    const line = JSON.stringify({ type: "error", message: "model rejected" });
    expect(() => parseGrokEvent(line)).toThrow(GrokErrorEvent);
    expect(() => parseGrokEvent(JSON.stringify({ type: "end", stopReason: "refusal" }))).toThrow(GrokErrorEvent);
    expect(() => parseGrokEvent(JSON.stringify({ type: "end" }))).toThrow(GrokErrorEvent);
    expect(() => parseGrokEvent(JSON.stringify({ type: "max_turns_reached" }))).toThrow(GrokErrorEvent);
    expect(parseGrokEvent(JSON.stringify({ type: "end", stopReason: "end_turn" }))).toBeNull();
    expect(parseGrokEvent(JSON.stringify({ type: "end", stopReason: "EndTurn" }))).toBeNull();
    expect(() => parseGrokEvent("not json")).toThrow(/Unparseable Grok event/);
  });

  it("a streamed error line fails the run through the adapter, not just the parser", async () => {
    const adapter = createRuntimeAdapter("sandbox", grokHarness);
    let emitOutput: ((stream: "stdout" | "stderr", data: string) => void) | null = null;
    const ops = {
      gitCheckout: async () => {},
      writeFile: async () => {},
      exec: async (_command: string, opts?: { onOutput?: (stream: "stdout" | "stderr", data: string) => void }) => {
        emitOutput = opts?.onOutput ?? null;
        emitOutput?.("stdout", `${JSON.stringify({ type: "error", message: "model rejected" })}\n`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async () => ({ kind: "utf8" as const, content: "" }),
    };
    const result = await adapter.runCodingTask(ops, input("xai/grok-4.6"), async () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("model rejected");
  });

  it("refuses non-xai models", () => {
    expect(() => grokHarness.egressHosts("openai/gpt-5")).toThrow(/grok harness supports/);
  });
});

describe("Pi harness", () => {
  it("runs headlessly in JSON mode with the provider prefix stripped from the model id", () => {
    expect(piHarness.configFile()).toBeNull();
    expect(piHarness.buildArgv(input("anthropic/claude-sonnet-4-6"), "/workspace/x")).toEqual([
      "pi",
      "--mode",
      "json",
      "--no-session",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4-6",
      "--",
      "Fix it.",
    ]);
  });

  it.each([
    ["anthropic/claude-sonnet-4-6", "ANTHROPIC_API_KEY"],
    ["openai/gpt-5.3-codex", "OPENAI_API_KEY"],
    ["google/gemini-3.5-flash-lite", "GEMINI_API_KEY"],
    ["xai/grok-4.6", "XAI_API_KEY"],
  ])("passes only the dummy key for %s", (model, keyName) => {
    expect(piHarness.env(input(model), null)).toEqual({
      [keyName]: "shiba-dummy-key",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_OFFLINE: "1",
    });
  });

  it("parses tool, text, and usage events with cache tokens folded into the delta", () => {
    expect(parsePiEvent("  ")).toBeNull();
    expect(parsePiEvent(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }))).toEqual({
      kind: "tool",
      name: "bash",
      text: "tool: bash",
    });
    expect(parsePiEvent(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
    }))).toEqual({ kind: "text", text: "Done." });
    expect(parsePiEvent(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Edited a file." }],
        usage: {
          input: 10,
          output: 3,
          cacheRead: 4,
          cacheWrite: 2,
          cost: { total: 0.002 },
        },
        stopReason: "stop",
      },
    }))).toEqual({
      kind: "usage",
      cumulative: false,
      usage: { inputTokens: 16, outputTokens: 3, costUsd: 0.002 },
      text: "Edited a file.",
    });
  });

  it("throws for assistant errors, aborts, and malformed JSONL", () => {
    expect(() => parsePiEvent(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "401 invalid key" },
    }))).toThrow(PiErrorEvent);
    expect(() => parsePiEvent(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted" },
    }))).toThrow(PiErrorEvent);
    expect(() => parsePiEvent(JSON.stringify({ type: "agent_settled", aborted: true }))).toThrow(PiErrorEvent);
    expect(() => parsePiEvent("not JSON")).toThrow(PiEventError);
    expect(() => parsePiEvent("[]")).toThrow(PiEventError);
    expect(() => parsePiEvent("null")).toThrow(PiEventError);
  });

  it("ignores Pi lifecycle and tool-update noise", () => {
    for (const type of [
      "session",
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "tool_execution_update",
      "tool_execution_end",
      "queue_update",
      "compaction_start",
      "compaction_end",
      "auto_retry_start",
      "auto_retry_end",
    ]) {
      expect(parsePiEvent(JSON.stringify({ type }))).toBeNull();
    }
  });

  it("parses every line from the real offline smoke and detects its assistant auth error", () => {
    const lines = readFileSync(new URL("./fixtures/pi-smoke.jsonl", import.meta.url), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim());
    const errors: unknown[] = [];
    for (const line of lines) {
      try {
        parsePiEvent(line);
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(PiErrorEvent);
    expect((errors[0] as PiErrorEvent).detail).toContain("invalid x-api-key");
  });

  it("fails a runtime run on Pi's streamed assistant error even when the CLI exits zero", async () => {
    const adapter = createRuntimeAdapter("sandbox", piHarness);
    const ops = {
      gitCheckout: async () => {},
      writeFile: async () => {},
      exec: async (_command: string, opts?: { onOutput?: (stream: "stdout" | "stderr", data: string) => void }) => {
        opts?.onOutput?.("stdout", `${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "401 invalid key" },
        })}\n`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      readFile: async () => ({ kind: "utf8" as const, content: "" }),
    };
    const result = await adapter.runCodingTask(ops, input("anthropic/claude-sonnet-4-6"), async () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("401 invalid key");
  });

  it("refuses unsupported providers", () => {
    expect(() => piHarness.egressHosts("mistral/large")).toThrow(/pi harness supports/);
  });
});

describe("connection compatibility stays honest", () => {
  it("cursor is a remote executor — no sandbox harness drives it", () => {
    // The grok service row routes through the xai namespace; cursor stays a
    // remote executor with no sandbox-compatible harness.
    expect(compatibleHarnesses("cursor")).toEqual([]);
    expect(compatibleHarnesses("anthropic")).toContain("claude-code");
    expect(compatibleHarnesses("anthropic")).toContain("opencode");
    expect(compatibleHarnesses("anthropic")).toContain("pi");
    // The new fleet lanes resolve to real provider namespaces.
    expect(compatibleHarnesses("grok")).toContain("grok");
    expect(compatibleHarnesses("grok")).toContain("opencode");
    expect(compatibleHarnesses("grok")).toContain("pi");
    expect(compatibleHarnesses("luan")).toEqual(["opencode", "opencode-acp"]);
  });
});

describe("agent cli catalog", () => {
  it("lists every registered harness with its pinned version", () => {
    const catalog = agentCliCatalog({});
    expect(catalog.map((a) => a.id)).toEqual([
      "opencode",
      "claude-code",
      "claude-login",
      "codex",
      "grok",
      "pi",
      "claude-acp",
      "codex-acp",
      "gemini-acp",
      "opencode-acp",
    ]);
    expect(catalog.find((a) => a.id === "grok")?.version).toBe("1.0.41");
    expect(catalog.find((a) => a.id === "grok")?.defaultModel).toBe("xai/grok-4.6");
    expect(catalog.find((a) => a.id === "pi")?.version).toBe("1.3.0");
    expect(catalog.find((a) => a.id === "pi")?.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(HARNESS_MODEL_ENV.pi).toBe("PI_MODEL");
    expect(HARNESS_DEFAULT_MODELS.pi).toBe("anthropic/claude-sonnet-4-6");
  });

  it("marks gateway-backed harnesses as not introspectable", () => {
    const opencode = agentCliCatalog({}).find((a) => a.id === "opencode");
    expect(opencode?.credential.kind).toBe("ai-gateway-byok");
    expect(opencode?.credential.configured).toBeNull();
  });
});
