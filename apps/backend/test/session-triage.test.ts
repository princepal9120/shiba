import { describe, expect, it } from "vitest";
import { evaluateSessionTriage } from "../src/session-triage.js";

function makeStubFetch(answers: Record<string, unknown> | null, status = 200) {
  return async () => {
    if (status !== 200) return new Response("error", { status });
    return Response.json(answers === null ? {} : { answers });
  };
}

describe("evaluateSessionTriage", () => {
  it("returns null when API key is empty", async () => {
    const triage = await evaluateSessionTriage("", "Fix typo in readme", "https://github.com/owner/repo");
    expect(triage).toBeNull();
  });

  it("parses valid complexity score and risk choice answers from Jev", async () => {
    const stub = makeStubFetch({
      complexity: { score: 1.2, confidence: 0.95 },
      risk: { choice: "low", probabilities: { low: 0.9, medium: 0.1, high: 0.0 } },
    });
    const triage = await evaluateSessionTriage("test-key", "Add unit test for auth", "https://github.com/owner/repo", stub);
    expect(triage).not.toBeNull();
    expect(triage?.complexity).toBe("moderate");
    expect(triage?.risk).toBe("low");
    expect(triage?.confidence).toBe(0.95);
  });

  it("fails open (returns null) on HTTP error", async () => {
    const stub = makeStubFetch(null, 500);
    const triage = await evaluateSessionTriage("test-key", "Refactor everything", "https://github.com/owner/repo", stub);
    expect(triage).toBeNull();
  });
});
