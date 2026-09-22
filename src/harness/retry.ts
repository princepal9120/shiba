/**
 * Effect-runtime supervision for harness operations: a bounded retry budget
 * over transient failures, gated by the run-level error classifier
 * (src/run-errors.ts). Deterministic only — no model calls.
 *
 * `withRetry` keeps its promise/AbortSignal boundary; internally it is an
 * `Effect.retry` over a real Schedule — `exponential` backoff, each delay
 * capped at `maxDelayMs` via `modifyDelay` (not `Schedule.upTo`, which bounds
 * a schedule's total elapsed rather than any single wait), then
 * `jitteredWith({min: 0, max: 1})` — the full-jitter family member that
 * reproduces this module's documented law (each wait uniform in
 * [0, capped]); plain `jittered`'s ±20% band is a different distribution.
 * An intersected `recurs(maxAttempts - 1)` bounds the attempt count.
 *
 * Jitter draws from a Math.random-backed `Random` service. `Random.next`
 * resolves through the runtime-services fiberRef rather than the effect
 * environment, so a `Layer`/`provide` cannot reach it — `Effect.withRandom`
 * can. That keeps `backoffDelayMs`, which literally steps the same schedule,
 * and the runtime's waits on one RNG.
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
import { Cause, Chunk, Duration, Effect, Exit, Fiber, Random, Schedule } from "effect";

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
 * A `Random` service whose draws are `Math.random()` — one RNG for the
 * schedule's jitter and for callers/tests that mock `Math.random` directly.
 */
const MATH_RANDOM: Random.Random = {
  [Random.RandomTypeId]: Random.RandomTypeId,
  next: Effect.sync(() => Math.random()),
  nextBoolean: Effect.sync(() => Math.random() > 0.5),
  nextInt: Effect.sync(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
  nextRange: (min: number, max: number) =>
    Effect.sync(() => min + Math.random() * (max - min)),
  nextIntBetween: (min: number, max: number) =>
    Effect.sync(() => min + Math.floor(Math.random() * (max - min))),
  shuffle: <A>(elements: Iterable<A>) =>
    Effect.sync(() => {
      const array = Array.from(elements);
      for (let i = array.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = array[i]!;
        array[i] = array[j]!;
        array[j] = tmp;
      }
      return Chunk.fromIterable(array);
    }),
};

/**
 * Exponential backoff with the cap folded in before jitter: the nth wait is
 * uniform in [0, min(base * 2^(n-1), maxDelayMs)], exactly the previous
 * plain-TS law. Capping before jitter keeps `maxDelayMs` a hard bound
 * regardless of the jitter band.
 */
const delaySchedule = (policy: RetryPolicy): Schedule.Schedule<Duration.Duration> =>
  Schedule.jitteredWith(
    Schedule.modifyDelay(Schedule.exponential(policy.baseDelayMs), (_out, delay) =>
      Duration.millis(Math.min(Duration.toMillis(delay), policy.maxDelayMs)),
    ),
    { min: 0, max: 1 },
  );

/**
 * The budget as a Schedule: `delaySchedule` supplies each wait;
 * `recurs(maxAttempts - 1)` bounds the retries so attempts total
 * `maxAttempts`. Exported so tests can step the schedule's delays
 * (`Schedule.delays` + `Schedule.driver`) instead of sleeping through them.
 */
export const retrySchedule = (
  policy: RetryPolicy,
): Schedule.Schedule<[Duration.Duration, number]> =>
  Schedule.intersect(
    delaySchedule(policy),
    Schedule.recurs(Math.max(0, policy.maxAttempts - 1)),
  );

/**
 * Full jitter (AWS-style): each wait is uniform in [0, capped], where the cap
 * is this attempt's exponential delay. Jitter can only shorten a wait, so
 * maxDelayMs stays a hard bound and the test ceiling is deterministic.
 *
 * This is the closed form of the law `delaySchedule` encodes as
 * exponential → cap → jitter(0..1): `Random.next` draws `Math.random`
 * (`MATH_RANDOM`), so one mockable RNG drives both. The `retrySchedule`
 * metadata test steps the schedule itself and pins the same values, which
 * keeps this formula and the schedule from drifting apart.
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
  const fiber = Effect.runFork(Effect.withRandom(program, MATH_RANDOM));
  const onAbort = () => Effect.runFork(Fiber.interrupt(fiber));
  signal?.addEventListener("abort", onAbort, { once: true });
  // An abort fired between the fork and the listener attaching — e.g. the
  // task aborts inside its own first synchronous stretch — isn't seen by the
  // listener, so check once more after attaching.
  if (signal?.aborted) onAbort();
  try {
    const exit = await Effect.runPromiseExit(Fiber.join(fiber));
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.isInterruptedOnly(exit.cause)) throw cancelled();
    throw Cause.squash(exit.cause);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
