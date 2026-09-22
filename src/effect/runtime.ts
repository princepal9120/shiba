/**
 * Effect boundary helpers — the single edge where Effect code meets the
 * worker's promise/AbortSignal world (spec B2).
 *
 * `runWorkerEffect` is the only place an Effect is executed: it never
 * rejects with raw Effect internals. Failures — tagged errors, defects,
 * interruption — come out as `RunFailure` carrying `{code, wire}` in the
 * same RunErrorCode vocabulary the rest of the worker uses, so callers
 * can tell a classified failure (`instanceof RunFailure`) from any other
 * unexpected rejection.
 */
import { Cause, Chunk, Effect, Exit } from "effect";

import {
  classifyRunError,
  RunError,
  runErrorWire,
  toTaggedError,
  type RunErrorCode,
  type RunErrorWire,
} from "../run-errors.js";

/** The rejection a classified Effect failure crosses the boundary as. */
export class RunFailure extends Error {
  readonly code: RunErrorCode;
  readonly wire: RunErrorWire;

  constructor(code: RunErrorCode, message: string) {
    super(message);
    this.name = "RunFailure";
    this.code = code;
    this.wire = runErrorWire(code);
  }
}

/**
 * Cause → RunFailure. A solely-interrupted cause maps to cancelled (a
 * mixed cause reports the defect/failure, which is more informative);
 * then defects; then tagged RunError failures, whose code is already
 * authoritative.
 */
const toRunFailure = (cause: Cause.Cause<unknown>): RunFailure => {
  if (Cause.isInterruptedOnly(cause)) {
    return new RunFailure("cancelled", "interrupted");
  }
  const defects = Chunk.toReadonlyArray(Cause.defects(cause));
  if (defects.length > 0) {
    const { code, message } = classifyRunError(defects[0]);
    return new RunFailure(code, message);
  }
  for (const failure of Chunk.toReadonlyArray(Cause.failures(cause))) {
    if (failure instanceof RunError) {
      return new RunFailure(failure.code, failure.message);
    }
  }
  const { code, message } = classifyRunError(Cause.squash(cause));
  return new RunFailure(code, message);
};

/**
 * The single edge: run an Effect and get a Promise. Success passes
 * through; any failure rejects with a `RunFailure`.
 */
export async function runWorkerEffect<A, E>(eff: Effect.Effect<A, E, never>): Promise<A> {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isSuccess(exit)) return exit.value;
  throw toRunFailure(exit.cause);
}

/**
 * Wrap a legacy promise-returning call (sandbox client, Slack, GitHub)
 * as an Effect failing with a tagged `RunError`. `codeHint` fills in only
 * when classification lands on `internal_error` — an explicit status,
 * quota text, or abort in the error always wins. The thunk receives an
 * AbortSignal that fires when the fiber is interrupted.
 */
export const tryRunPromise = <A>(
  thunk: (signal: AbortSignal) => Promise<A>,
  codeHint?: RunErrorCode,
): Effect.Effect<A, RunError> =>
  Effect.async<A, RunError>((resume, signal) => {
    Promise.resolve()
      .then(() => thunk(signal))
      .then(
        (value) => resume(Effect.succeed(value)),
        (error) => {
          const classified = classifyRunError(error);
          const code =
            classified.code === "internal_error" && codeHint ? codeHint : classified.code;
          resume(Effect.fail(toTaggedError(code, classified.message)));
        },
      );
  });

/**
 * AbortSignal bridge: `make` gets a fresh controller's signal; if the
 * fiber is interrupted the controller aborts, so legacy abort-aware
 * async work sees the interruption.
 */
export const effectWithSignal = <A, E, R>(
  make: (signal: AbortSignal) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.onInterrupt(make(controller.signal), () =>
        Effect.sync(() => {
          controller.abort();
        }),
      ),
  );
