import { describe, expect, it } from "vitest";
import {
  RESULT_MARKER,
  TOOL_INPUT_MARKER,
  formatAgentResult,
  formatAgentToolInput,
  parseAgentResultText,
  parseAgentToolInput,
  type CodingTaskInput,
} from "../src/opencode-input.js";

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix the login redirect.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

describe("agent tool input envelope", () => {
  it("round-trips through format and parse", () => {
    const envelope = formatAgentToolInput(INPUT);
    expect(envelope.startsWith(`${TOOL_INPUT_MARKER}\n`)).toBe(true);
    expect(parseAgentToolInput([{ role: "user", text: envelope }])).toEqual(INPUT);
  });

  it("uses the latest envelope when several exist", () => {
    const first = formatAgentToolInput(INPUT);
    const second = formatAgentToolInput({ ...INPUT, task: "Second task." });
    const parsed = parseAgentToolInput([
      { role: "user", text: first },
      { role: "assistant", text: "working" },
      { role: "user", text: second },
    ]);
    expect(parsed.task).toBe("Second task.");
  });

  it("accepts a JSON-wrapped envelope", () => {
    const envelope = formatAgentToolInput(INPUT);
    const wrapped = JSON.stringify({ envelope });
    expect(parseAgentToolInput([{ role: "user", text: wrapped }])).toEqual(INPUT);
  });

  it("accepts the raw input object as JSON", () => {
    expect(parseAgentToolInput([{ role: "user", text: JSON.stringify(INPUT) }])).toEqual(INPUT);
  });

  it("never scrapes free prose", () => {
    expect(() =>
      parseAgentToolInput([
        { role: "user", text: "Please work on https://github.com/owner/repo and fix login." },
      ]),
    ).toThrow(/structured/i);
  });

  it("rejects envelopes with bad fields or bad URLs", () => {
    const bad = `${TOOL_INPUT_MARKER}\n${JSON.stringify({ ...INPUT, repoUrl: "http://evil/x" })}`;
    expect(() => parseAgentToolInput([{ role: "user", text: bad }])).toThrow();
    const missing = `${TOOL_INPUT_MARKER}\n${JSON.stringify({ repoUrl: INPUT.repoUrl })}`;
    expect(() => parseAgentToolInput([{ role: "user", text: missing }])).toThrow();
  });

  it("rejects invalid JSON envelopes", () => {
    expect(() =>
      parseAgentToolInput([{ role: "user", text: `${TOOL_INPUT_MARKER}\n{nope` }]),
    ).toThrow();
  });
});

describe("agent result envelope", () => {
  it("round-trips through format and parse", () => {
    const result = {
      status: "completed" as const,
      exitCode: 0,
      stderrTail: "",
      changedFiles: ["a.ts"],
      diff: "diff --git a/a.ts",
      files: [{ path: "a.ts", content: "x", encoding: "utf8" as const }],
      summary: "done",
    };
    const text = `some prose\n${formatAgentResult(result)}`;
    expect(text).toContain(RESULT_MARKER);
    expect(parseAgentResultText(text)).toEqual(result);
  });

  it("carries an optional pullUrl through the envelope", () => {
    const result = {
      status: "completed" as const,
      exitCode: 0,
      stderrTail: "",
      changedFiles: [],
      diff: "",
      files: [],
      summary: "done",
      pullUrl: "https://github.com/owner/repo/pull/7",
    };
    expect(parseAgentResultText(formatAgentResult(result)).pullUrl).toBe(result.pullUrl);
  });

  it("rejects text without a result envelope", () => {
    expect(() => parseAgentResultText("just prose")).toThrow();
  });
});
