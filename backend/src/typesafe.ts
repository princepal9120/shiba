/**
 * The one TypeSafe System One POST scaffold. Every integration — the
 * run_when Noul gate (automations.ts), the Slack intent Choice
 * (slack-mention.ts), and the run quality Score (result-quality.ts) — goes
 * through postSystemOne and a typed reader here, so the endpoint, auth
 * header, request envelope, and null-on-error contract exist exactly once.
 *
 * Contract: https://docs.typesafe.ai/api — POST /v1/systemone, Bearer key,
 * { state, model: "jev-latest", questions }, answers keyed by question id.
 * Jev is TypeSafe's System One model: it returns typed judgments and
 * probabilities, not generated text.
 *
 * Keep policy (thresholds, levels, intent lists) in the callers; this module
 * owns transport and shape only. Callers decide their own failure semantics —
 * the run_when gate fails CLOSED, the intent classifier and quality score
 * fail OPEN.
 */

export const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";

/** Pluggable fetch so tests inject a stub. */
export type TypeSafeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type SystemOneQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: readonly string[] };

/**
 * POST one evaluation. Returns the raw `answers` map, or null on any
 * HTTP/parse/network failure — never throws, never returns partial shapes.
 */
export async function postSystemOne(
  apiKey: string,
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
  fetchImpl: TypeSafeFetch = fetch,
): Promise<Record<string, unknown> | null> {
  const key = apiKey.trim();
  if (!key) return null;
  try {
    const response = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: TYPESAFE_MODEL, questions }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const answers = (body as { answers?: unknown }).answers;
    if (typeof answers !== "object" || answers === null) return null;
    return answers as Record<string, unknown>;
  } catch {
    return null;
  }
}

function answerAt(answers: Record<string, unknown>, id: string): Record<string, unknown> | null {
  const answer = answers[id];
  return typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Noul answer: the probability the yes/no question is yes. */
export function readNoulAnswer(answers: Record<string, unknown>, id: string): number | null {
  return finiteNumber(answerAt(answers, id)?.noul);
}

/** Choice answer: the selected option plus its probability from the distribution. */
export function readChoiceAnswer(
  answers: Record<string, unknown>,
  id: string,
): { choice: string; probability: number } | null {
  const answer = answerAt(answers, id);
  if (!answer || typeof answer.choice !== "string") return null;
  const probabilities =
    typeof answer.probabilities === "object" && answer.probabilities !== null
      ? (answer.probabilities as Record<string, unknown>)
      : {};
  const probability = finiteNumber(probabilities[answer.choice]) ?? 0;
  return { choice: answer.choice, probability };
}

/** Score answer: the probability-weighted position across the levels, plus confidence. */
export function readScoreAnswer(
  answers: Record<string, unknown>,
  id: string,
): { score: number; confidence: number } | null {
  const answer = answerAt(answers, id);
  const score = finiteNumber(answer?.score);
  if (score === null) return null;
  return { score, confidence: finiteNumber(answer?.confidence) ?? 0 };
}
