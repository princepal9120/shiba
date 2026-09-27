/**
 * Frozen, approval-gated model route. Recorded on pending approvals, run
 * receipts, and child envelopes — ids only, never credentials.
 */

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
}

export function isApprovedRoute(value: unknown): value is ApprovedRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return (
    route.purpose === "coding" &&
    (typeof route.connectionId === "string" || route.connectionId === null) &&
    typeof route.modelId === "string" &&
    typeof route.harness === "string" &&
    typeof route.policyVersion === "number"
  );
}

/** Human-readable route summary for approval cards and run receipts. */
export function describeRoute(route: ApprovedRoute, connectionName?: string | null): string {
  const via = connectionName ?? route.connectionId ?? "deployment default";
  return `${route.harness} · ${route.modelId} · via ${via}`;
}
