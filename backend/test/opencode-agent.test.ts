import { readUIMessageStream, type UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAgent, createSandboxOps } from "../src/agents/opencode-agent.js";
import { formatAgentToolInput, parseAgentResultText, type CodingTaskInput, type CodingTaskResult } from "../src/opencode-input.js";

const mocks = vi.hoisted(() => ({
  run: vi.fn(), publish: vi.fn(), sandbox: vi.fn(), progress: vi.fn(), decodeFile: vi.fn(),
}));
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: mocks.sandbox, streamFile: mocks.decodeFile }));
vi.mock("../src/runtime.js", () => ({
  createRuntimeAdapter: () => ({ runCodingTask: mocks.run }),
  resolveRuntimeName: (name?: string) => name ?? "sandbox",
}));
vi.mock("../src/github.js", () => ({ publishFilesAsPullRequest: mocks.publish }));

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo", task: "Fix it.", baseBranch: "main",
  publishPullRequest: false, sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};
const RESULT: CodingTaskResult = {
  status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["a.ts"],
  diff: "+fixed", files: [{ path: "a.ts", content: "complete file", encoding: "utf8" }], summary: "Done.",
};

function agent(input = INPUT, token?: string) {
  return Object.assign(Object.create(OpenCodeAgent.prototype) as OpenCodeAgent, {
    env: { GITHUB_TOKEN: token },
    messages: [{ id: "input", role: "user", parts: [{ type: "text", text: formatAgentToolInput(input) }] }],
    reportProgress: mocks.progress,
  });
}

async function responseFor(instance: OpenCodeAgent, signal?: AbortSignal) {
  const response = await instance.onChatMessage(() => {}, { requestId: "test", abortSignal: signal });
  expect(response?.headers.get("content-type")).toContain("text/event-stream");
  const chunks = (await response!.text()).split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk);
  const text = chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("");
  return { chunks, text, result: parseAgentResultText(text) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sandbox.mockReturnValue({});
  mocks.run.mockResolvedValue(RESULT);
  mocks.publish.mockResolvedValue({ pullUrl: "https://github.com/owner/repo/pull/1" });
});

describe("OpenCodeAgent response boundary", () => {
  it("returns a complete assistant stream the SDK can reconstruct without manual persistence", async () => {
    const { chunks, result } = await responseFor(agent());
    const messages = [];
    for await (const message of readUIMessageStream({ stream: new ReadableStream({
      start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); },
    }) })) messages.push(message);
    expect(messages.at(-1)?.role).toBe("assistant");
    expect(messages.at(-1)?.parts).toEqual([{ type: "text", text: expect.stringContaining("AI_INTERN_CODING_RESULT_JSON"), state: "done" }]);
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    expect(result.files).toEqual([]);
  });

  it("bounds and redacts progress, rendered output, and result without exposing raw files", async () => {
    const token = "opaque-installation-credential";
    const secret = "ghp_1234567890abcdef";
    mocks.run.mockImplementation(async (_ops, _input, emit) => {
      for (let i = 0; i < 1000; i++) await emit({ phase: "code", message: `${secret} ${token} ${"x".repeat(5000)}`, fraction: 0.5 });
      return { ...RESULT, summary: `${secret} ${token}`, diff: `${"x".repeat(40_000)}${secret} ${token}`,
        stderrTail: secret, files: [{ path: "private", content: "RAW_FILE_MUST_NOT_LEAVE", encoding: "utf8" }] };
    });
    const { text, result } = await responseFor(agent(INPUT, token));
    expect(text).not.toContain(secret);
    expect(text).not.toContain(token);
    expect(text).not.toContain("RAW_FILE_MUST_NOT_LEAVE");
    expect(text).toContain("[redacted]");
    expect(text.length).toBeLessThan(70_000);
    expect(result.diff.length).toBeLessThan(20_100);
    expect(result.files).toEqual([]);
    expect(mocks.progress.mock.calls.length).toBeLessThanOrEqual(100);
    for (const [event] of mocks.progress.mock.calls) {
      expect(event.message.length).toBeLessThan(2100);
      expect(event.message).not.toContain(secret);
      expect(event.message).not.toContain(token);
    }
  });

  it("passes original complete files and null deletions only to Worker publication", async () => {
    const files: CodingTaskResult["files"] = [
      { path: "secret.txt", content: "ghp_1234567890abcdef", encoding: "utf8" },
      { path: "gone.txt", content: null, encoding: "utf8" },
    ];
    mocks.run.mockResolvedValue({ ...RESULT, files });
    const signal = new AbortController().signal;
    const { text, result } = await responseFor(agent({ ...INPUT, publishPullRequest: true }, "token"), signal);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ files }));
    expect(result.files).toEqual([]);
    expect(text).not.toContain(files[0]!.content);
    expect(text).toContain("Pull request: https://github.com/owner/repo/pull/1");
  });

  it("returns a structured safe failure when runtime throws", async () => {
    mocks.run.mockRejectedValue(new Error("Failed ghp_1234567890abcdef"));
    const { chunks, text, result } = await responseFor(agent());
    expect(result).toMatchObject({ status: "error", exitCode: -1, files: [], summary: "Failed [redacted]" });
    expect(text).not.toContain("ghp_1234567890abcdef");
    expect(chunks).toContainEqual({ type: "error", errorText: "Failed [redacted]" });
  });

  it("keeps process exit code and marks a returned runtime failure as an SDK error", async () => {
    mocks.run.mockResolvedValue({ ...RESULT, status: "error", exitCode: 7, summary: "OpenCode exited with code 7." });
    const { chunks, result } = await responseFor(agent());
    expect(result.exitCode).toBe(7);
    expect(chunks).toContainEqual({ type: "error", errorText: "OpenCode exited with code 7." });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("fails before sandbox creation for missing publication credentials", async () => {
    const { result } = await responseFor(agent({ ...INPUT, publishPullRequest: true }));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("GITHUB_TOKEN is not configured");
    expect(mocks.sandbox).not.toHaveBeenCalled();
  });

  it("reports sandbox setup errors through the structured result", async () => {
    mocks.sandbox.mockImplementation(() => { throw new Error("Sandbox unavailable"); });
    const { result } = await responseFor(agent());
    expect(result).toMatchObject({ status: "error", summary: "Sandbox unavailable" });
  });

  it("short-circuits a pre-aborted request before sandbox creation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await responseFor(agent(), controller.signal);
    expect(result).toMatchObject({ status: "error", summary: "Run cancelled." });
    expect(mocks.sandbox).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("propagates cancellation and prevents publishing after cancellation during coding", async () => {
    const controller = new AbortController();
    mocks.run.mockImplementation(async (_ops, _input, _emit, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return RESULT;
    });
    const { result } = await responseFor(agent({ ...INPUT, publishPullRequest: true }, "token"), controller.signal);
    expect(result.summary).toBe("Run cancelled.");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("reports a publication error instead of emitting coding success", async () => {
    mocks.publish.mockRejectedValue(new Error("GitHub unavailable"));
    const { result, text } = await responseFor(agent({ ...INPUT, publishPullRequest: true }, "token"));
    expect(result.status).toBe("error");
    expect(result.summary).toBe("GitHub unavailable");
    expect(text).not.toContain("Pull request:");
  });
});

describe("createSandboxOps", () => {
  it.each([
    { chunks: ["hello ", "world"], expected: { kind: "utf8", content: "hello world" } },
    { chunks: [new Uint8Array([0, 255, 1])], expected: { kind: "base64", content: "AP8B" } },
  ])("collects decoded SDK file chunks without treating SSE as content", async ({ chunks, expected }) => {
    const stream = new ReadableStream<Uint8Array>();
    mocks.sandbox.mockReturnValue({ readFileStream: vi.fn().mockResolvedValue(stream) });
    mocks.decodeFile.mockImplementation(async function* () { yield* chunks; });
    expect(await createSandboxOps({} as never, INPUT.sandboxId).readFile("a.txt")).toEqual(expected);
    expect(mocks.decodeFile).toHaveBeenCalledWith(stream);
  });

  it("rejects oversized decoded files rather than publishing a truncated file", async () => {
    mocks.sandbox.mockReturnValue({ readFileStream: vi.fn().mockResolvedValue(new ReadableStream()) });
    mocks.decodeFile.mockImplementation(async function* () { yield "x".repeat(500_001); });
    await expect(createSandboxOps({} as never, INPUT.sandboxId).readFile("large.txt")).rejects.toThrow("limit");
  });

  it("scopes the GitHub credential to the run's repo before cloning (B6)", async () => {
    const calls: string[] = [];
    const approveRepoScope = vi.fn(async () => { calls.push("approve"); });
    const gitCheckout = vi.fn(async () => { calls.push("clone"); });
    mocks.sandbox.mockReturnValue({ approveRepoScope, gitCheckout });
    await createSandboxOps({} as never, INPUT.sandboxId)
      .gitCheckout("https://github.com/owner/repo", { branch: "main", targetDir: "/workspace" });
    expect(approveRepoScope).toHaveBeenCalledWith("/owner/repo");
    // Scoping must precede the clone, or the clone itself runs unscoped.
    expect(calls).toEqual(["approve", "clone"]);
  });

  it("narrows egress to the selected harness's hosts before cloning (T22)", async () => {
    const calls: string[] = [];
    const approveHarnessEgress = vi.fn(async () => { calls.push("egress"); });
    const approveRepoScope = vi.fn(async () => { calls.push("scope"); });
    const gitCheckout = vi.fn(async () => { calls.push("clone"); });
    mocks.sandbox.mockReturnValue({ approveHarnessEgress, approveRepoScope, gitCheckout });
    await createSandboxOps({} as never, INPUT.sandboxId, ["api.anthropic.com", "github.com"])
      .gitCheckout("https://github.com/owner/repo", { branch: "main", targetDir: "/workspace" });
    expect(approveHarnessEgress).toHaveBeenCalledWith(["api.anthropic.com", "github.com"]);
    expect(calls).toEqual(["egress", "scope", "clone"]);
  });

  it("refuses to clone a non-GitHub repo rather than scoping nothing", async () => {
    const approveRepoScope = vi.fn();
    const gitCheckout = vi.fn();
    mocks.sandbox.mockReturnValue({ approveRepoScope, gitCheckout });
    await expect(
      createSandboxOps({} as never, INPUT.sandboxId)
        .gitCheckout("https://evil.example.com/owner/repo", { branch: "main", targetDir: "/workspace" }),
    ).rejects.toThrow();
    expect(gitCheckout).not.toHaveBeenCalled();
  });

  it("forwards execution cancellation and preserves process exit code", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "out", stderr: "err", exitCode: 4 });
    mocks.sandbox.mockReturnValue({ exec });
    const signal = new AbortController().signal;
    const ops = createSandboxOps({} as never, INPUT.sandboxId);
    expect(await ops.exec("command", { cwd: "/workspace", timeoutMs: 100, signal })).toEqual({ stdout: "out", stderr: "err", exitCode: 4 });
    expect(exec).toHaveBeenCalledWith("command", expect.objectContaining({ cwd: "/workspace", timeout: 100, signal }));
  });
});
