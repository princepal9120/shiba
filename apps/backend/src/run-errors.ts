/**
 * Run-level error classification: the classifier and Effect bridge. The
 * closed RunErrorCode vocabulary, status mapping, and wire projection
 * live in @shiba/shared (re-exported below for existing imports).
 *
 * Effect bridge (spec B3): a single `RunError` Data.TaggedError carrying
 * `code` — chosen over one tagged class per code as the smallest bridge
 * that lets Effect code `catchTag("RunError")` while keeping
 * `RunErrorCode` the only vocabulary.
 */
import { statusToRunCode } from "@shiba/shared";
import type { RunErrorCode } from "@shiba/shared";
import { Data } from "effect";

export { RUN_ERROR_DEFS, runErrorWire, statusToRunCode } from "@shiba/shared";
export type { RunErrorCode, RunErrorWire } from "@shiba/shared";

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
  "GrokErrorEvent",
  "CursorErrorEvent",
  "AntigravityErrorEvent",
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
    // An already-classified failure is authoritative: a RunError carries the
    // code the Effect boundary chose from this same vocabulary, so re-deriving
    // it from name/message would lose information (e.g. cancelled). A foreign
    // `.code` field is not honored — it can collide with the vocabulary while
    // meaning something else entirely.
    if (error instanceof RunError) {
      return { code: error.code, message };
    }
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

/** One tagged class for every run error — the code does the dispatching. */
export class RunError extends Data.TaggedError("RunError")<{
  code: RunErrorCode;
  message: string;
}> {}

/** Lift a classified run error into an Effect-typed failure. */
export const toTaggedError = (code: RunErrorCode, message: string): RunError =>
  new RunError({ code, message });
