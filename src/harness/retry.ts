/**
 * Effect-runtime supervision for harness operations: a bounded retry budget
 * over transient failures, gated by the run-level error classifier
 * (src/run-errors.ts). Deterministic only — no model calls.
 *
 * `withRetry` keeps its promise/AbortSignal boundary; internally it is an
 * `Effect.retry` over a real Schedule — `exponential` backoff, each delay
 * jittered and capped inside `modifyDelay` (`Schedule.jittered` only offers
 * a fixed ±20% band, a different distribution than the law below), then
 * bounded by `Schedule.max([delay, recurs(maxAttempts - 1)])` — recur while
 * BOTH schedules want another step, waiting the maximum delay, which is
 * `delaySchedule`'s since `recurs` emits none.
 *
 * Jitter draws are `Math.random` — the same mockable RNG `backoffDelayMs`
 * (the closed form of the same law) uses, so tests pin both surfaces with
 * one `vi.spyOn(Math, "random")`.
 *
 * The caller's signal bridges to a real fiber interrupt (`runFork` +
 * `Fiber.interrupt` from an abort listener — the same seam as
 * src/sandbox/lifecycle.ts), so an abort mid-backoff kills the wait instead
 * of sleeping it out. Outcomes cross the promise boundary as the raw thrown
 * values callers already see — the `Exit` is unwrapped by hand rather than
 * through `runWorkerEffect` so error identity (`instanceof`, `.cause`)
 * survives.
 *
 * A RetryExhaustedError is itself classified: its name maps to
 * "supervision_exhausted", and its message still matches the envelope
 * classifier's "retry budget exhausted" text — pinned by tests since the
 * flattened form is what the orchestrator classifies.
 */
import { Cause, Duration, Effect, Exit, Fiber, Schedule } from "effect";

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
 * Exponential backoff with cap and full jitter folded into `modifyDelay`:
 * the nth wait is uniform in [0, min(base * 2^(n-1), maxDelayMs)], exactly
 * the previous plain-TS law. Capping before jitter keeps `maxDelayMs` a
 * hard bound. `Schedule.jittered` is not used — it only offers a fixed
 * ±20% band, a different distribution.
 */
const delaySchedule = (policy: RetryPolicy): Schedule.Schedule<Duration.Duration> =>
  Schedule.modifyDelay(Schedule.exponential(policy.baseDelayMs), ({ duration }) =>
    Effect.succeed(
      Duration.millis(Math.min(Duration.toMillis(duration), policy.maxDelayMs) * Math.random()),
    ),
  );

/**
 * The budget as a Schedule: `delaySchedule` supplies each wait;
 * `recurs(maxAttempts - 1)` bounds the retries so attempts total
 * `maxAttempts` — `Schedule.max` recurs while all member schedules do,
 * taking the maximum delay, which is `delaySchedule`'s. Exported so tests
 * can step the schedule's delays (`Schedule.toStep`) instead of sleeping
 * through them.
 */
export const retrySchedule = (policy: RetryPolicy): Schedule.Schedule<Duration.Duration> =>
  Schedule.max([delaySchedule(policy), Schedule.recurs(Math.max(0, policy.maxAttempts - 1))]);

/**
 * Full jitter (AWS-style): each wait is uniform in [0, capped], where the cap
 * is this attempt's exponential delay. Jitter can only shorten a wait, so
 * maxDelayMs stays a hard bound and the test ceiling is deterministic.
 *
 * This is the closed form of the law `delaySchedule` encodes as
 * exponential → cap → jitter(0..1) — one mockable `Math.random` RNG drives
 * both. The `retrySchedule` metadata test steps the schedule itself and
 * pins the same values, which keeps this formula and the schedule from
 * drifting apart.
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
 * The failure that survives once the budget stops retrying: an abort is
 * never rewritten, an abort signal wins over a late transient error, a
 * still-transient error becomes the exhausted-budget failure, and anything
 * else passes through as the task's own verdict.
 */
const finalizeRetryError = (
  policy: RetryPolicy,
  signal: AbortSignal | undefined,
  error: unknown,
): unknown =>
  isAbortError(error)
    ? error
    : signal?.aborted
      ? cancelled()
      : policy.retryIf(error)
        ? new RetryExhaustedError(policy.maxAttempts, error)
        : error;

/**
 * Run `task` under `policy`'s budget. Aborts are never retried — belt and
 * suspenders: neither an AbortError thrown by the task nor the caller's
 * signal transitioning mid-flight buys another attempt, and a signal
 * aborting during the backoff wait interrupts it promptly.
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw cancelled();
  const program = Effect.mapError(
    Effect.retry(
      Effect.tryPromise({ try: task, catch: (error) => error }),
      {
        schedule: retrySchedule(policy),
        while: (error) => !isAbortError(error) && policy.retryIf(error),
      },
    ),
    (error) => finalizeRetryError(policy, signal, error),
  );
  const fiber = Effect.runFork(program);
  const onAbort = () => Effect.runFork(Fiber.interrupt(fiber));
  signal?.addEventListener("abort", onAbort, { once: true });
  // An abort fired between the fork and the listener attaching — e.g. the
  // task aborts inside its own first synchronous stretch — isn't seen by the
  // listener, so check once more after attaching.
  if (signal?.aborted) onAbort();
  try {
    const exit = await Effect.runPromiseExit(Fiber.join(fiber));
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.hasInterruptsOnly(exit.cause)) throw cancelled();
    throw Cause.squash(exit.cause);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
