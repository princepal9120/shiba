/**
 * Run-level error classification, ported from CF-Open-Agents-API's
 * statusToTurnCode + DEFINITE error table, in plain TypeScript.
 * Deterministic only: no model calls, no parsing of unstructured prose
 * beyond an explicit "status <3-digit>" context.
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

/**
 * Extract an HTTP status only when it is explicitly stated as one — a bare
 * 3-digit number (commit hash, file count, port) must never classify.
 */
const STATUS_CONTEXT_RE = /(?:status(?: code)?|HTTP)\s*[:=]?\s*([1-5]\d{2})\b/i;

/**
 * Cloudflare quota code 10400 — like STATUS_CONTEXT_RE it requires an
 * explicit context word ("code", "error", "errno", "status"); a bare 10400
 * is a count, not a quota failure.
 */
const QUOTA_CONTEXT_RE = /(?:status|code|error|errno)\s*[:=]?\s*10400\b/i;

/**
 * Strong container-death signals always classify — a dead sandbox is the
 * root cause even when a secondary HTTP status appears alongside. A bare
 * "out of memory" is weak (JS heap, CUDA, V8): it only means container
 * death next to a container-context word, otherwise normal flow continues.
 */
const CONTAINER_DEATH_STRONG_RE = /\bsigkill(?:ed)?\b|\boom[\s_-]?kill(?:ed)?\b|\boom\b/i;
const CONTAINER_DEATH_WEAK_RE = /out[\s_-]of[\s_-]memory/i;
const CONTAINER_CONTEXT_RE = /\b(?:sandbox|container|instance|pod)\b/i;

/**
 * Overall-run deadline language requires a run/sandbox/overall-qualified
 * subject AND a failure verb or "timed out" form. Configuration ("the run
 * timeout is 900s") and loose prose ("we missed the deadline") never
 * classify — only the run's own deadline failing does.
 */
const TIMEOUT_SCOPE_RE =
  /\b(?:run|sandbox)\s+timed[\s-]+out\b|\b(?:(?:run|sandbox)\s+|overall\s+(?:run\s+)?)(?:deadline|timeout)\s*(?:was\s+|is\s+)?(?:exceeded|reached|hit|expired|missed|passed|reclaimed)\b|\b(?:run|sandbox)\s+(?:exceeded|hit|reached|expired)\s+(?:its|the|a)\s+(?:[\w-]+\s+){0,4}(?:timeout|deadline)\b|\boverall\s+(?:run\s+)?timeout\b|\breclaimed\b[^.;]*\bdeadline\b/i;

/**
 * RetryExhaustedError survives flattening only as its message — the runtime
 * boundary stringifies it into failureResult summaries, so the exhaustion
 * phrase must classify too or "supervision_exhausted" is unreachable.
 */
const RETRY_EXHAUSTED_TEXT_RE = /\bretry budget (?:was\s+)?exhausted\b/i;

const HARNESS_ERROR_NAMES = new Set([
  "OpenCodeErrorEvent",
  "ClaudeCodeErrorEvent",
  "CodexErrorEvent",
  "DevinErrorEvent",
]);

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Classify any thrown value into a RunErrorCode. Harness error events are
 * executor failures unless the message carries an explicit HTTP status.
 * Never throws.
 */
export function classifyRunError(error: unknown): { code: RunErrorCode; message: string } {
  try {
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    if (isAbortError(error)) return { code: "cancelled", message };
    // The retry budget being spent is the failure, whatever the attempts saw.
    if (
      (error instanceof Error && error.name === "RetryExhaustedError") ||
      RETRY_EXHAUSTED_TEXT_RE.test(message)
    ) {
      return { code: "supervision_exhausted", message };
    }
    if (
      CONTAINER_DEATH_STRONG_RE.test(message) ||
      (CONTAINER_DEATH_WEAK_RE.test(message) && CONTAINER_CONTEXT_RE.test(message))
    ) {
      return { code: "container_lost", message };
    }
    if (QUOTA_CONTEXT_RE.test(message)) return { code: "quota_exhausted", message };
    if (TIMEOUT_SCOPE_RE.test(message)) return { code: "timeout_scope", message };
    const match = STATUS_CONTEXT_RE.exec(message);
    if (match) {
      const status = Number(match[1]);
      if (status === 401 && /expired/i.test(message)) {
        return { code: "credential_expired", message };
      }
      return { code: statusToRunCode(status), message };
    }
    if (error instanceof Error && HARNESS_ERROR_NAMES.has(error.name)) {
      return { code: "executor_failed", message };
    }
    return { code: "internal_error", message };
  } catch {
    return { code: "internal_error", message: "unclassifiable error" };
  }
}

/**
 * Classify a structured failure envelope returned BY the executor. The error
 * name is lost at the agent/RPC boundary, so harness classes cannot match —
 * an unclassified envelope is an executor failure, not an internal error.
 */
export function classifyExecutorError(error: unknown): { code: RunErrorCode; message: string } {
  const classified = classifyRunError(error);
  return classified.code === "internal_error"
    ? { code: "executor_failed", message: classified.message }
    : classified;
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
