/**
 * Run-level error classification: a closed RunErrorCode vocabulary, an
 * HTTP-status/known-text classifier, and a single wire projection
 * (`runErrorWire`) for API responses and Slack posts. Deterministic only.
 */
export type RunErrorCode =
  | "authentication_error"
  | "resource_not_found"
  | "request_timeout"
  | "rate_limit_exceeded"
  | "server_overloaded"
  | "server_error"
  | "invalid_request"
  | "executor_failed"
  | "outcome_unknown"
  | "egress_denied"
  | "cancelled"
  | "internal_error"
  | "container_lost"
  | "credential_expired"
  | "quota_exhausted"
  | "timeout_scope"
  | "supervision_exhausted";

/** HTTP status -> error code, ported from their statusToTurnCode. */
export function statusToRunCode(httpStatus: number | null): RunErrorCode {
  if (httpStatus === null) return "internal_error";
  if (httpStatus === 401 || httpStatus === 403) return "authentication_error";
  if (httpStatus === 404) return "resource_not_found";
  if (httpStatus === 408) return "request_timeout";
  if (httpStatus === 429) return "rate_limit_exceeded";
  if (httpStatus === 503 || httpStatus === 529) return "server_overloaded";
  if (httpStatus >= 500) return "server_error";
  if (httpStatus >= 400) return "invalid_request";
  return "internal_error";
}

export const RUN_ERROR_DEFS = {
  authentication_error: {
    userFacing: true,
    summary: "Authentication failed — check provider credentials.",
  },
  resource_not_found: {
    userFacing: true,
    summary: "A requested resource was not found.",
  },
  request_timeout: {
    userFacing: true,
    summary: "The request timed out; retrying may succeed.",
  },
  rate_limit_exceeded: {
    userFacing: true,
    summary: "Rate limit exceeded — retry after a backoff.",
  },
  server_overloaded: {
    userFacing: true,
    summary: "The provider is overloaded; retry later.",
  },
  server_error: {
    userFacing: false,
    summary: "An upstream server error occurred.",
  },
  invalid_request: {
    userFacing: true,
    summary: "The request was rejected as invalid.",
  },
  executor_failed: {
    userFacing: false,
    summary: "The coding executor failed inside the sandbox.",
  },
  outcome_unknown: {
    userFacing: true,
    summary: "The run's outcome is unknown — side effects are unverified; it may have pushed or opened a PR.",
  },
  egress_denied: {
    userFacing: true,
    summary: "A network egress request was denied by policy.",
  },
  cancelled: {
    userFacing: true,
    summary: "The run was cancelled. Side effects already in flight may have completed — verify repository state before retrying.",
  },
  internal_error: {
    userFacing: false,
    summary: "An internal error occurred.",
  },
  container_lost: {
    userFacing: true,
    summary: "The sandbox container died mid-run — side effects are unverified.",
  },
  credential_expired: {
    userFacing: true,
    summary: "The provider credential expired — rotate or refresh it and retry.",
  },
  quota_exhausted: {
    userFacing: true,
    summary: "A Cloudflare or account quota was exhausted — check usage limits and billing.",
  },
  timeout_scope: {
    userFacing: true,
    summary: "The run hit its overall deadline — side effects are unverified; verify repository state before retrying.",
  },
  supervision_exhausted: {
    userFacing: false,
    summary: "The retry budget was exhausted after repeated failed attempts.",
  },
} satisfies Record<RunErrorCode, { userFacing: boolean; summary: string }>;

export interface RunErrorWire {
  status: "error" | "unknown";
  code: RunErrorCode;
  userMessage: string;
}

/**
 * The single projection for API responses and Slack posts. Carries no raw
 * error text — raw text lives on the run record after redactSecrets.
 */
export function runErrorWire(code: RunErrorCode): RunErrorWire {
  return {
    status: code === "outcome_unknown" || code === "container_lost" ? "unknown" : "error",
    code,
    userMessage: RUN_ERROR_DEFS[code].summary,
  };
}
