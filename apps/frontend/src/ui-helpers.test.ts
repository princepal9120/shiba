import { describe, expect, it, vi } from "vitest";
import { formatToolOutput, readPromptParam, runsListUrl } from "./ui-helpers";

describe("runsListUrl", () => {
  it("requests the lean summary projection for ordinary views", () => {
    expect(runsListUrl("sess-1", false, false)).toBe("/api/runs?view=summary");
    expect(runsListUrl("sess-1", true, false)).toBe(
      "/api/runs?session=sess-1&view=summary",
    );
  });

  it("requests the full payload only for detail views", () => {
    expect(runsListUrl("sess-1", false, true)).toBe("/api/runs");
    expect(runsListUrl("a b", true, true)).toBe("/api/runs?session=a+b");
  });
});

describe("formatToolOutput", () => {
  const partWith = (output: unknown) =>
    ({ type: "tool-x", output }) as never;

  it("returns null for missing output and raw strings verbatim", () => {
    expect(formatToolOutput(partWith(undefined))).toBeNull();
    expect(formatToolOutput(partWith(null))).toBeNull();
    expect(formatToolOutput(partWith("done"))).toBe("done");
  });

  it("memoizes serialization by output object identity", () => {
    const spy = vi.spyOn(JSON, "stringify");
    const output = { files: ["a.ts", "b.ts"], ok: true };
    const first = formatToolOutput(partWith(output));
    const second = formatToolOutput(partWith(output));
    expect(second).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("reserializes a different output object", () => {
    const spy = vi.spyOn(JSON, "stringify");
    formatToolOutput(partWith({ n: 1 }));
    formatToolOutput(partWith({ n: 2 }));
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("readPromptParam", () => {
  it("prefills prompt and strips it from search, leaving other params intact", () => {
    const { prompt, nextSearch } = readPromptParam("?tab=activity&prompt=fix%20the%20login%20bug");
    expect(prompt).toBe("fix the login bug");
    expect(nextSearch).toBe("?tab=activity");
  });

  it("returns empty nextSearch when prompt is the only param", () => {
    const { prompt, nextSearch } = readPromptParam("?prompt=fix%20the%20login%20bug");
    expect(prompt).toBe("fix the login bug");
    expect(nextSearch).toBe("");
  });

  it("returns null prompt and preserves search when prompt param is absent", () => {
    const { prompt, nextSearch } = readPromptParam("?tab=dashboard");
    expect(prompt).toBeNull();
    expect(nextSearch).toBe("?tab=dashboard");
  });

  it("returns null prompt when search is empty", () => {
    const { prompt, nextSearch } = readPromptParam("");
    expect(prompt).toBeNull();
    expect(nextSearch).toBe("");
  });

  it("ignores empty or whitespace-only prompt values", () => {
    expect(readPromptParam("?prompt=").prompt).toBeNull();
    expect(readPromptParam("?prompt=%20%20").prompt).toBeNull();
  });

  it("caps prefilled prompt text at 4000 characters", () => {
    const longPrompt = "x".repeat(5000);
    const { prompt, nextSearch } = readPromptParam(`?prompt=${longPrompt}`);
    expect(prompt?.length).toBe(4000);
    expect(prompt).toBe("x".repeat(4000));
    expect(nextSearch).toBe("");
  });
});
