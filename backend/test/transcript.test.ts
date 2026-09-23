import { createUIMessageStream, createUIMessageStreamResponse, readUIMessageStream } from "ai";
import { describe, expect, it } from "vitest";
import type { CodingTaskInput, CodingTaskResult } from "../src/opencode-input.js";
import { messageText, renderRunTranscript } from "../src/transcript.js";

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

describe("messageText", () => {
  it("joins text parts and ignores the rest", () => {
    expect(
      messageText({ parts: [{ type: "text", text: "a" }, { type: "tool-x", toolCallId: "1" }, { type: "text", text: "b" }] }),
    ).toBe("a\nb");
  });

  it("returns empty for non-messages", () => {
    expect(messageText(null)).toBe("");
    expect(messageText({})).toBe("");
  });

  it("ignores null, primitive, and non-text parts without throwing", () => {
    expect(
      messageText({ parts: [null, 42, "raw", { type: "text", text: 7 }, { type: "text" }, { type: "text", text: "ok" }] }),
    ).toBe("ok");
  });

  it("returns empty for empty or missing parts arrays", () => {
    expect(messageText({ parts: [] })).toBe("");
    expect(messageText({ parts: "not-an-array" })).toBe("");
  });
});

describe("renderRunTranscript", () => {
  it.each(["completed", "error"] as const)("redacts secrets from %s output", (status) => {
    const secret = "ghp_1234567890abcdef";
    const result: CodingTaskResult = {
      status,
      exitCode: status === "completed" ? 0 : 3,
      stderrTail: `Authentication failed: ${secret}`,
      changedFiles: ["config.txt"],
      diff: `+token=${secret}`,
      files: [],
      summary: "Authentication failed.",
    };
    const text = renderRunTranscript({ input: INPUT, progress: [], result }).join("\n");
    expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
  });

  it("renders a successful no-op without empty diff or pull request sections", () => {
    expect(renderRunTranscript({
      input: INPUT,
      progress: [],
      result: { status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "done" },
    })).toEqual([
      "Task: Fix it.",
      "Repository: https://github.com/owner/repo (main)",
      "Sandbox: run-abcdef12345678",
      "No file changes detected.",
    ]);
  });

  it.each([20_000, 20_001])("bounds a %i-character diff while preserving its tail", (length) => {
    const diff = "a".repeat(length - 4) + "END!";
    const lines = renderRunTranscript({
      input: INPUT,
      progress: [],
      result: { status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["a.ts"], diff, files: [], summary: "done" },
    });
    expect(lines[lines.indexOf("Diff:") + 1]).toBe(
      length === 20_000 ? diff : `…[truncated 1 chars]\n${diff.slice(-20_000)}`,
    );
  });

  it("does not present partial artifacts or a pull request as success after failure", () => {
    const lines = renderRunTranscript({
      input: INPUT,
      progress: [],
      result: { status: "error", exitCode: 3, stderrTail: "", changedFiles: ["partial.ts"], diff: "partial diff", files: [], summary: "Command failed." },
      pullUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(lines.slice(3)).toEqual(["Failed: Command failed."]);
  });

  it("renders progress, files, diff, and pull request", () => {
    const lines = renderRunTranscript({
      input: INPUT,
      progress: [{ phase: "clone", message: "Cloned.", fraction: 0.1 }],
      result: {
        status: "completed",
        exitCode: 0,
        stderrTail: "",
        changedFiles: ["a.ts"],
        diff: "diff --git a/a.ts",
        files: [],
        summary: "done",
      },
      pullUrl: "https://github.com/owner/repo/pull/1",
    });
    const text = lines.join("\n");
    expect(text).toContain("Fix it.");
    expect(text).toContain("[clone] Cloned.");
    expect(text).toContain("Changed files: a.ts");
    expect(text).toContain("Pull request: https://github.com/owner/repo/pull/1");
  });

  it("renders failures honestly", () => {
    const lines = renderRunTranscript({
      input: INPUT,
      progress: [],
      result: {
        status: "error",
        exitCode: 3,
        stderrTail: "boom",
        changedFiles: [],
        diff: "",
        files: [],
        summary: "OpenCode exited with code 3.",
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("Failed: OpenCode exited with code 3.");
    expect(text).toContain("boom");
  });
});

describe("agent UI stream shape", () => {
  it("round-trips the exact writer pattern used by OpenCodeAgent", async () => {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "text-start", id: "run-log" });
        writer.write({ type: "text-delta", id: "run-log", delta: "hello\n" });
        writer.write({ type: "text-end", id: "run-log" });
      },
    });
    const response = createUIMessageStreamResponse({ stream });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sseText = await response.text();
    const chunks: unknown[] = [];
    for (const line of sseText.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice("data: ".length).trim();
      if (payload === "[DONE]") continue;
      chunks.push(JSON.parse(payload));
    }
    // The wire payloads carry our exact chunk shapes.
    expect(chunks).toContainEqual({ type: "text-start", id: "run-log" });
    expect(chunks).toContainEqual({ type: "text-delta", id: "run-log", delta: "hello\n" });
    expect(chunks).toContainEqual({ type: "text-end", id: "run-log" });
    // The SDK reconstructs the assistant message from those chunks.
    const messages = [];
    for await (const message of readUIMessageStream({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk as never);
          }
          controller.close();
        },
      }),
    })) {
      messages.push(message);
    }
    const last = messages[messages.length - 1];
    const text = (last?.parts ?? [])
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text).toBe("hello\n");
  });
});
