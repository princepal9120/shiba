/**
 * TypeSafe Score for run result quality.
 *
 * When TYPESAFE_API_KEY is set, evaluateResultQuality scores a completed run
 * against four ordered levels so callers can surface quality signals beyond a
 * binary exit-code check. Fail-open on any HTTP or parse error — quality is
 * advisory, never a gate. Transport and response shape come from the shared
 * scaffold in src/typesafe.ts.
 */
import { postSystemOne, readScoreAnswer, type TypeSafeFetch } from "./typesafe.js";

/** Four ordered quality levels, low to high. */
export const QUALITY_LEVELS = [
  "complete failure: nothing was accomplished; errors throughout",
  "partial with errors: some progress but significant failures or broken code",
  "partial success: mostly correct with minor issues or incomplete steps",
  "full success: task completed correctly and completely",
] as const;

export type QualityLevel = (typeof QUALITY_LEVELS)[number];

/** 0 = complete failure, 3 = full success (index into QUALITY_LEVELS). */
export interface ResultQuality {
  /** Score value in [0, 3]. Probability-weighted position across levels. */
  score: number;
  /** Confidence in [0, 1] summarising distribution concentration. */
  confidence: number;
  /** Human-readable level name closest to the score. */
  level: QualityLevel;
}

/** Pluggable fetch for tests. */
export type QualityFetchImpl = TypeSafeFetch;

function levelFromScore(score: number): QualityLevel {
  const idx = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, Math.round(score)));
  // idx is clamped to [0, QUALITY_LEVELS.length-1] by Math.max/min above
  return QUALITY_LEVELS[idx] as QualityLevel;
}

/**
 * Score a run result summary using TypeSafe Score.
 * Returns null when the API key is absent, on HTTP errors, or on parse failures.
 * Callers must treat null as "unknown quality" and not as success or failure.
 */
export async function evaluateResultQuality(
  apiKey: string,
  runSummary: string,
  fetchImpl: QualityFetchImpl = fetch,
): Promise<ResultQuality | null> {
  const answers = await postSystemOne(
    apiKey,
    { summary: runSummary },
    {
      quality: {
        type: "score",
        instructions:
          "How completely and correctly did the coding agent complete the task described in `summary`?",
        criteria: QUALITY_LEVELS,
      },
    },
    fetchImpl,
  );
  if (answers === null) return null;
  const parsed = readScoreAnswer(answers, "quality");
  if (!parsed) return null;
  return {
    score: parsed.score,
    confidence: parsed.confidence,
    level: levelFromScore(parsed.score),
  };
}

