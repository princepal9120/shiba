import { Cause, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { RunError, toTaggedError } from "../src/run-errors.js";
import {
  effectWithSignal,
  RunFailure,
  runWorkerEffect,
  tryRunPromise,
} from "../src/effect/runtime.js";

/** T42: deferred latch — the fiber under test resolves it, never a clock. */
const latch = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("runWorkerEffect", () => {
  it("passes a successful Effect's value through", async () => {
    await expect(runWorkerEffect(Effect.succeed(42))).resolves.toBe(42);
  });

  it("rejects a tagged RunError failure as RunFailure with the classified code", async () => {
    const rejection = runWorkerEffect(
      Effect.fail(toTaggedError("rate_limit_exceeded", "slow down")),
    );
    await expect(rejection).rejects.toBeInstanceOf(RunFailure);
    await expect(rejection).rejects.toMatchObject({
      code: "rate_limit_exceeded",
      wire: { status: "error", code: "rate_limit_exceeded" },
    });
  });

  it("keeps the unknown wire status for indeterminate codes", async () => {
    await expect(
      runWorkerEffect(Effect.fail(toTaggedError("container_lost", "oomkilled"))),
    ).rejects.toMatchObject({
      code: "container_lost",
      wire: { status: "unknown", code: "container_lost" },
    });
  });

  it("classifies an uncaught throw (defect) as internal_error", async () => {
    const eff = Effect.sync(() => {
      throw new Error("boom");
    });
    await expect(runWorkerEffect(eff)).rejects.toMatchObject({
      code: "internal_error",
      wire: { status: "error", code: "internal_error" },
    });
  });

  it("classifies fiber interruption as cancelled", async () => {
    await expect(runWorkerEffect(Effect.interrupt)).rejects.toMatchObject({
      code: "cancelled",
      wire: { status: "error", code: "cancelled" },
    });
  });
});

describe("tryRunPromise", () => {
  it("wraps a resolved promise as a success", async () => {
    await expect(runWorkerEffect(tryRunPromise(() => Promise.resolve("ok")))).resolves.toBe(
      "ok",
    );
  });

  it("wraps a rejection as a tagged RunError failure", async () => {
    const exit = await Effect.runPromiseExit(
      tryRunPromise(() => Promise.reject(new Error("provider returned status 429"))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause);
      expect(failure).toBeInstanceOf(RunError);
      expect((failure as RunError).code).toBe("rate_limit_exceeded");
    }
  });

  it("turns a synchronous thunk throw into a tagged failure, not a defect", async () => {
    const exit = await Effect.runPromiseExit(
      tryRunPromise(() => {
        throw new Error("status 503");
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause);
      expect(failure).toBeInstanceOf(RunError);
      expect((failure as RunError).code).toBe("server_overloaded");
    }
  });

  it("uses codeHint only when the rejection is otherwise unclassifiable", async () => {
    const exit = await Effect.runPromiseExit(
      tryRunPromise(() => Promise.reject(new Error("socket blew up")), "egress_denied"),
    );
    if (Exit.isFailure(exit)) {
      expect((Cause.squash(exit.cause) as RunError).code).toBe("egress_denied");
    } else {
      expect.unreachable();
    }
  });

  it("lets an explicit classification beat codeHint", async () => {
    const exit = await Effect.runPromiseExit(
      tryRunPromise(() => Promise.reject(new Error("status 503")), "egress_denied"),
    );
    if (Exit.isFailure(exit)) {
      expect((Cause.squash(exit.cause) as RunError).code).toBe("server_overloaded");
    } else {
      expect.unreachable();
    }
  });

  it("maps an AbortError rejection to cancelled", async () => {
    const exit = await Effect.runPromiseExit(
      tryRunPromise(() => Promise.reject(new DOMException("aborted", "AbortError"))),
    );
    if (Exit.isFailure(exit)) {
      expect((Cause.squash(exit.cause) as RunError).code).toBe("cancelled");
    } else {
      expect.unreachable();
    }
  });
});

describe("signal bridge", () => {
  it("effectWithSignal aborts the controller when the fiber is interrupted", async () => {
    // T42: the latch resolves when the fiber's work actually starts — no
    // fixed tick guessing at fiber startup.
    const started = latch<AbortSignal>();
    const fiber = Effect.runFork(
      effectWithSignal((signal) => {
        started.resolve(signal);
        return Effect.never;
      }),
    );
    const seen = await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(seen.aborted).toBe(true);
  });

  it("tryRunPromise propagates interruption to the underlying async work", async () => {
    const started = latch<AbortSignal>();
    const fiber = Effect.runFork(
      tryRunPromise((signal) => {
        started.resolve(signal);
        return new Promise<never>(() => {});
      }),
    );
    const seen = await started.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(seen.aborted).toBe(true);
  });
});
