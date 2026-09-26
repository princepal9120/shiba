/**
 * TypeSafe Jev Triage for Live Sessions & Task Intake.
 *
 * When TYPESAFE_API_KEY is configured, evaluateSessionTriage analyzes a
 * task and repository context before execution starts, classifying:
 *  - complexity: Score (trivial, moderate, complex, massive)
 *  - risk: Choice (low, medium, high)
 * Advisory and fail-open — never blocks a run.
 */
import { postSystemOne, readChoiceAnswer, readScoreAnswer, type TypeSafeFetch } from "./typesafe.js";

export const COMPLEXITY_LEVELS = [
  "trivial: typo, documentation, or one-line configuration fix",
  "moderate: focused single-file edit or small unit test addition",
  "complex: multi-file changes, API modifications, or dependency updates",
  "massive: large-scale architectural refactor, database migration, or cross-cutting feature",
] as const;

export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

export const RISK_OPTIONS = {
  low: "read-only, documentation, styling, or isolated test changes",
  medium: "business logic changes within existing tests and patterns",
  high: "destructive changes, migrations, authentication, security, or deletions",
} as const;

export type RiskLevel = keyof typeof RISK_OPTIONS;

export interface SessionTriage {
  complexityScore: number;
  complexity: string;
  risk: RiskLevel;
  confidence: number;
}

export type TriageFetchImpl = TypeSafeFetch;

export async function evaluateSessionTriage(
  apiKey: string,
  task: string,
  repoUrl: string,
  fetchImpl: TriageFetchImpl = fetch,
): Promise<SessionTriage | null> {
  const answers = await postSystemOne(
    apiKey,
    { task, repo: repoUrl },
    {
      complexity: {
        type: "score",
        instructions: "Rate the engineering complexity of completing the given task on the given repo.",
        criteria: COMPLEXITY_LEVELS,
      },
      risk: {
        type: "choice",
        instructions: "Assess the risk level of unintended side effects or regressions from executing the task.",
        criteria: RISK_OPTIONS,
      },
    },
    fetchImpl,
  );
  if (answers === null) return null;
  const complexityAnswer = readScoreAnswer(answers, "complexity");
  const riskAnswer = readChoiceAnswer(answers, "risk");
  if (!complexityAnswer || !riskAnswer) return null;

  const idx = Math.max(0, Math.min(COMPLEXITY_LEVELS.length - 1, Math.round(complexityAnswer.score)));
  const complexityShort = (COMPLEXITY_LEVELS[idx] ?? "").split(":")[0] ?? "moderate";
  const risk = (riskAnswer.choice in RISK_OPTIONS ? riskAnswer.choice : "medium") as RiskLevel;

  return {
    complexityScore: complexityAnswer.score,
    complexity: complexityShort,
    risk,
    confidence: complexityAnswer.confidence,
  };
}
