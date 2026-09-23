import { describe, expect, it } from "vitest";
import {
  QUALITY_LEVELS,
  evaluateResultQuality,
} from "../src/result-quality.js";

const SUCCESS_BODY = JSON.stringify({
  answers: { quality: { type: "score", score: 2.7, confidence: 0.9 } },
});
const PARTIAL_BODY = JSON.stringify({
  answers: { quality: { type: "score", score: 1.2, confidence: 0.6 } },
});
const FAILURE_BODY = JSON.stringify({
  answers: { quality: { type: "score", score: 0.1, confidence: 0.8 } },
});

function mockFetch(body: string, status = 200): typeof fetch {
  return async () => new Response(body, { status });
}

describe("evaluateResultQuality (TypeSafe Score — B8 augmentation)", () => {
  it("returns null when apiKey is empty", async () => {
    const result = await evaluateResultQuality("", "task ran fine", mockFetch(SUCCESS_BODY));
    expect(result).toBeNull();
  });

  it("returns null when apiKey is whitespace-only", async () => {
    const result = await evaluateResultQuality("   ", "task ran fine", mockFetch(SUCCESS_BODY));
    expect(result).toBeNull();
  });

  it("parses a high score as full success", async () => {
    const result = await evaluateResultQuality("ts-key", "task ran fine", mockFetch(SUCCESS_BODY));
    expect(result).not.toBeNull();
    expect(result!.score).toBeCloseTo(2.7, 5);
    expect(result!.confidence).toBeCloseTo(0.9, 5);
    expect(result!.level).toBe(QUALITY_LEVELS[3]); // "full success"
  });

  it("parses a mid score as partial with errors", async () => {
    const result = await evaluateResultQuality("ts-key", "half done", mockFetch(PARTIAL_BODY));
    expect(result).not.toBeNull();
    expect(result!.score).toBeCloseTo(1.2, 5);
    expect(result!.level).toBe(QUALITY_LEVELS[1]); // "partial with errors"
  });

  it("parses a low score as complete failure", async () => {
    const result = await evaluateResultQuality("ts-key", "crashed", mockFetch(FAILURE_BODY));
    expect(result).not.toBeNull();
    expect(result!.level).toBe(QUALITY_LEVELS[0]); // "complete failure"
  });

  it("returns null on HTTP error (fail closed)", async () => {
    const result = await evaluateResultQuality("ts-key", "task", mockFetch("error", 500));
    expect(result).toBeNull();
  });

  it("returns null when score field is missing from answer", async () => {
    const noScore = JSON.stringify({ answers: { quality: { type: "score" } } });
    const result = await evaluateResultQuality("ts-key", "task", mockFetch(noScore));
    expect(result).toBeNull();
  });

  it("returns null when answers field is missing", async () => {
    const noAnswers = JSON.stringify({ notAnswers: {} });
    const result = await evaluateResultQuality("ts-key", "task", mockFetch(noAnswers));
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    const throwFetch = async (): Promise<Response> => { throw new Error("network down"); };
    const result = await evaluateResultQuality("ts-key", "task", throwFetch);
    expect(result).toBeNull();
  });

  it("sends the correct TypeSafe Score request shape", async () => {
    let captured: RequestInit | undefined;
    const captureFetch: typeof fetch = async (_url, init) => {
      captured = init;
      return new Response(SUCCESS_BODY, { status: 200 });
    };
    await evaluateResultQuality("ts-key", "task ran fine", captureFetch);
    const sent = JSON.parse(captured?.body as string);
    expect(sent.model).toBe("jev-latest");
    expect(sent.state).toEqual({ summary: "task ran fine" });
    expect(sent.questions.quality.type).toBe("score");
    expect(Array.isArray(sent.questions.quality.criteria)).toBe(true);
    expect(sent.questions.quality.criteria).toHaveLength(4);
  });

  it("confidence defaults to 0 when absent", async () => {
    const noConf = JSON.stringify({
      answers: { quality: { type: "score", score: 2.0 } },
    });
    const result = await evaluateResultQuality("ts-key", "task", mockFetch(noConf));
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0);
  });
});

