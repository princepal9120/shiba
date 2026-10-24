/**
 * Frozen, approval-gated model route. Recorded on pending approvals, run
 * receipts, and child envelopes — ids only, never credentials.
 */

/** Reasoning effort levels, lowest to highest. Each harness accepts a subset. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Levels each harness's CLI flag accepts (claude `--effort`, codex
 * `model_reasoning_effort`, opencode `--variant`). A harness absent here
 * cannot honor an effort, so a run asking for one is refused at route time.
 */
// ponytail: opencode variants are provider-specific; low/medium/high is the set every built-in provider ships.
export const HARNESS_REASONING_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  "claude-subscription": ["low", "medium", "high", "xhigh", "max"],
  "claude-login": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  opencode: ["low", "medium", "high"],
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * The frozen, approval-gated route for one coding run. `connectionId` null
 * = the deployment's implicit gateway/secret default for the resolved
 * provider.
 */
export interface ApprovedRoute {
  purpose: "coding";
  connectionId: string | null;
  modelId: string;
  harness: string;
  policyVersion: number;
  /** Absent = the harness/model default. Hashed with the route like every other field. */
  reasoningEffort?: ReasoningEffort;
}

export function isApprovedRoute(value: unknown): value is ApprovedRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return (
    route.purpose === "coding" &&
    (typeof route.connectionId === "string" || route.connectionId === null) &&
    typeof route.modelId === "string" &&
    typeof route.harness === "string" &&
    typeof route.policyVersion === "number" &&
    (route.reasoningEffort === undefined || isReasoningEffort(route.reasoningEffort))
  );
}

/** Human-readable route summary for approval cards and run receipts. */
export function describeRoute(route: ApprovedRoute, connectionName?: string | null): string {
  const via = connectionName ?? route.connectionId ?? "deployment default";
  const effort = route.reasoningEffort !== undefined ? ` · effort ${route.reasoningEffort}` : "";
  return `${route.harness} · ${route.modelId}${effort} · via ${via}`;
}
