/**
 * Effect-style supervision for harness operations: a bounded retry budget
 * over transient failures, gated by the run-level error classifier
 * (src/run-errors.ts). Deterministic only — no model calls.
 *
 * A RetryExhaustedError is itself classified: its name maps to
 * "supervision_exhausted", so an exhausted budget surfaces as its own
 * terminal failure rather than the last attempt's transient one.
 */
import { classifyRunError, type RunErrorCode } from "../run-errors.js";

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Delay for the first retry; each later retry doubles it. */
  baseDelayMs: number;
  /** Hard bound on any single wait (the jitter ceiling). */
  maxDelayMs: number;
  /** Whether an error is a transient failure worth another attempt. */
  retryIf: (error: unknown) => boolean;
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`Retry budget exhausted after ${attempts} attempts.`, { cause });
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
  }
}

/** Codes that mean "try again later": load, quota pacing, flaky transport. */
const RETRYABLE_CODES: ReadonlySet<RunErrorCode> = new Set([
  "server_overloaded",
  "rate_limit_exceeded",
  "request_timeout",
  "server_error",
]);

export function classifyRetryable(error: unknown): boolean {
  return RETRYABLE_CODES.has(classifyRunError(error).code);
}

/**
 * The retry budget for a single harness operation: three attempts, full
 * jitter in [0, min(base * 2^(n-1), 4s)] between them.
 */
export const HARNESS_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  retryIf: classifyRetryable,
};

/**
 * Full jitter (AWS-style): each wait is uniform in [0, capped], where the cap
 * is this attempt's exponential delay. Jitter can only shorten a wait, so
 * maxDelayMs stays a hard bound and the test ceiling is deterministic.
 */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.random() * Math.min(exponential, policy.maxDelayMs);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cancelled(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * A wait that ends early (resolving false) when the caller's signal aborts,
 * so a cancelled run never sleeps out a long backoff.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `task` under `policy`'s budget. Aborts are never retried — belt and
 * suspenders: neither an AbortError thrown by the task nor the caller's
 * signal transitioning mid-flight buys another attempt, and a signal
 * aborting during the backoff wait stops it promptly.
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) throw error;
      if (signal?.aborted) throw cancelled();
      if (!policy.retryIf(error)) throw error;
      if (attempt === policy.maxAttempts) break;
      if (!(await sleep(backoffDelayMs(policy, attempt), signal))) {
        throw cancelled();
      }
    }
  }
  throw new RetryExhaustedError(policy.maxAttempts, lastError);
}
