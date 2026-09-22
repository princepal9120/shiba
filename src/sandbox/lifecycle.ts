/**
 * Scoped container lifecycle — Effect's acquire → use → release pattern
 * on the sandbox container seam (spec B4: Scope-native).
 *
 * `acquireContainer` is an `Effect.acquireRelease`: the returned
 * ManagedContainer carries a scope finalizer that releases it exactly once
 * on success, failure, or interruption. `runWithContainer` keeps the
 * promise-returning wrapper for plain-async callers — inside it is an
 * `Effect.scoped(Effect.gen(...))` run through `runWorkerEffect`, so
 * outcomes cross the boundary as classified RunFailures.
 *
 * Released containers are fenced by a generation bump — the same token
 * pattern as DelegatedRun.generation in src/runs.ts — so post-release ops
 * reject with ContainerReleasedError instead of silently reaching a dead
 * container. A failed release marks the container leaked and records it in
 * a module-level registry so reclaim/onStart paths can find and retry
 * containers that could not be destroyed.
 *
 * Testability is structural: acquire/release are injected, so this module is
 * exercised without @cloudflare/sandbox. The production helpers below defer
 * their SDK imports the same way the orchestrator's destroySandbox did.
 */
import { Cause, Effect, Exit, Fiber } from "effect";
import type { Scope } from "effect";

import { effectWithSignal, runWorkerEffect } from "../effect/runtime.js";
import type { Env } from "../env.js";
import type { SandboxOps } from "../runtime.js";
import { redactSecrets } from "../security.js";

/** A sandbox ops call attempted after its container was released or leaked. */
export class ContainerReleasedError extends Error {
  constructor(readonly sandboxId: string) {
    super(`Sandbox container ${sandboxId} was released; ops are fenced.`);
    this.name = "ContainerReleasedError";
  }
}

/** A released-or-leaked view of one managed container. */
export interface ManagedContainer {
  readonly sandboxId: string;
  /** Fencing token: bumped on release; post-release ops reject. */
  readonly generation: number;
  readonly released: boolean;
  readonly leaked: boolean;
  /** Every method throws ContainerReleasedError after release. */
  readonly ops: SandboxOps;
}

class ManagedContainerImpl implements ManagedContainer {
  private _generation = 0;
  private _released = false;
  private _leaked = false;
  readonly ops: SandboxOps;

  constructor(
    readonly sandboxId: string,
    private readonly inner: SandboxOps,
    /** Ops adopt this signal when a call doesn't carry its own — the scope wires the one interruption forwards to. */
    private readonly fallbackSignal?: AbortSignal,
  ) {
    this.ops = {
      gitCheckout: (repoUrl, opts) => this.call(() => inner.gitCheckout(repoUrl, opts)),
      writeFile: (path, content) => this.call(() => inner.writeFile(path, content)),
      exec: (command, opts) =>
        this.call(() => inner.exec(command, { ...opts, signal: opts?.signal ?? this.fallbackSignal })),
      readFile: (path, opts) =>
        this.call(() => inner.readFile(path, { ...opts, signal: opts?.signal ?? this.fallbackSignal })),
    };
  }

  get generation(): number {
    return this._generation;
  }

  get released(): boolean {
    return this._released;
  }

  get leaked(): boolean {
    return this._leaked;
  }

  markReleased(): void {
    this._released = true;
    this._generation += 1;
  }

  markLeaked(): void {
    this._released = true;
    this._leaked = true;
    this._generation += 1;
  }

  private call<T>(op: () => Promise<T>): Promise<T> {
    if (this._released) {
      return Promise.reject(new ContainerReleasedError(this.sandboxId));
    }
    return op();
  }
}

export interface LeakedContainer {
  readonly sandboxId: string;
  readonly leakedAt: number;
  /** Redacted error text — safe to log or surface in reclaim diagnostics. */
  readonly error: string;
}

// Per-isolate: a Durable Object hibernation resets this registry. A later
// failed destroy re-records the leak, so reclaim loses at most one pass.
const leakedRegistry = new Map<string, LeakedContainer>();
let leakedCount = 0;

/** Total release failures seen since this module loaded. */
export function leakedContainerCount(): number {
  return leakedCount;
}

/** Read-only view of containers whose release failed, for reclaim/onStart. */
export function leakedContainers(): readonly LeakedContainer[] {
  return [...leakedRegistry.values()];
}

/** Drop the registry entry after a retry-destroy succeeded. */
export function forgetLeaked(sandboxId: string): void {
  leakedRegistry.delete(sandboxId);
}

function recordLeak(sandboxId: string, error: unknown): void {
  leakedCount += 1;
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  leakedRegistry.set(sandboxId, { sandboxId, leakedAt: Date.now(), error: message.slice(0, 2000) });
}

/**
 * Effect-native acquire: wraps `opts.acquire`'s ops in a managed container
 * and registers release as a Scope finalizer, so it runs exactly once on
 * success, failure, or interruption — no finally bookkeeping.
 *
 * `opts.signal` is the fallback ops signal: `SandboxOps.exec`/`readFile`
 * calls that don't carry their own adopt it, so interrupting the fiber
 * aborts in-flight ops (`runWithContainer` forwards interruption to it via
 * `effectWithSignal`). A signal passed per-call always wins.
 *
 * Release failure marks the container leaked, records it for reclaim, logs
 * the sandboxId only, and re-raises — a task error always wins over a
 * release error (defects order first in the close cause), so the recorded
 * outcome is never masked.
 */
export const acquireContainer = (opts: {
  acquire: () => Promise<SandboxOps>;
  release: (sandboxId: string) => Promise<void>;
  sandboxId: string;
  signal?: AbortSignal;
}): Effect.Effect<ManagedContainer, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(
      async () => new ManagedContainerImpl(opts.sandboxId, await opts.acquire(), opts.signal),
    ),
    (container) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Effect.promise(() => opts.release(opts.sandboxId)));
        if (Exit.isSuccess(exit)) {
          container.markReleased();
          return;
        }
        container.markLeaked();
        recordLeak(opts.sandboxId, Cause.squash(exit.cause));
        console.error(`Failed to release sandbox container ${opts.sandboxId}`);
        yield* Effect.failCause(exit.cause);
      }),
  );

/**
 * Acquire a container, run `task` with it, and release it exactly once —
 * release runs whether the task returns, throws, or the fiber is
 * interrupted. Internally `Effect.scoped(Effect.gen(...))`; the wrapper
 * stays promise-returning so plain-async callers are unchanged.
 *
 * `signal` is checked after acquire and watched during the task: aborting
 * it interrupts the program's fiber (`Fiber.interrupt` from the abort
 * listener), so release still runs even for a task that never settles.
 * Interrupting also aborts the scope controller via `effectWithSignal`,
 * and ops that didn't carry their own signal (`SandboxOps.exec`/`readFile`
 * adopt it as a fallback) see that abort — a per-call signal always wins.
 *
 * Task, release, and abort outcomes cross the boundary as classified
 * `RunFailure`s via `runWorkerEffect` — a task error always wins over a
 * release error so the recorded outcome is never masked.
 */
export async function runWithContainer<T>(
  opts: {
    acquire: () => Promise<SandboxOps>;
    release: (sandboxId: string) => Promise<void>;
    sandboxId: string;
    signal?: AbortSignal;
  },
  task: (container: ManagedContainer) => T | Promise<T>,
): Promise<T> {
  // Aborts interrupt the fiber only while the task is in-flight: an abort
  // landing during release must not poison a completed task's result — a
  // late result beats a fake-failed real one. The flag flips inside the
  // program so the abort listener can't race the scope close.
  let taskInFlight = false;
  const program = Effect.scoped(
    effectWithSignal((scopeSignal) =>
      Effect.gen(function* () {
        const container = yield* acquireContainer({ ...opts, signal: scopeSignal });
        yield* Effect.sync(() => opts.signal?.throwIfAborted());
        taskInFlight = true;
        return yield* Effect.ensuring(
          Effect.promise(() => Promise.resolve(task(container))),
          Effect.sync(() => {
            taskInFlight = false;
          }),
        );
      }),
    ),
  );
  // The caller's signal bridges to a real fiber interrupt: the program's
  // fiber is only ever awaited through runWorkerEffect — the single edge.
  const fiber = Effect.runFork(program);
  const onAbort = () => {
    if (taskInFlight) Effect.runFork(Fiber.interrupt(fiber));
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await runWorkerEffect(Fiber.join(fiber));
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Container handle returned by the SDK's getSandbox, narrowed to release. */
export interface SandboxHandle {
  destroy(): Promise<void>;
}

/** Resolves a container handle — production default loads the SDK lazily. */
export type SandboxHandleResolver = (binding: Env["Sandbox"], sandboxId: string) => SandboxHandle;

let sandboxHandleResolver: SandboxHandleResolver | undefined;

/**
 * Test seam: inject a handle resolver so tests never load @cloudflare/sandbox.
 * A detached async continuation (an abort listener's rejection landing in a
 * finally) can bypass vi.mock's dynamic-import interception, so tests must
 * not rely on mocking the module — set this instead.
 */
export function setSandboxHandleResolver(resolver: SandboxHandleResolver | undefined): void {
  sandboxHandleResolver = resolver;
}

/**
 * Production release path: destroy the sandbox container, routing failures
 * through the leak registry (warn + track, never throw) so reclaim/onStart can
 * find leaked containers. A successful destroy clears any stale leak record.
 */
export async function destroyManagedContainer(env: Env, sandboxId: string): Promise<void> {
  try {
    const resolve = sandboxHandleResolver ?? (await import("@cloudflare/sandbox")).getSandbox;
    await resolve(env.Sandbox, sandboxId).destroy();
    forgetLeaked(sandboxId);
  } catch (error) {
    // Cleanup failure must not overwrite the recorded outcome.
    console.warn(`Failed to destroy sandbox ${sandboxId}: ${redactSecrets(String(error))}`);
    recordLeak(sandboxId, error);
  }
}

/** Factory the production acquire path delegates to (opencode-agent's createSandboxOps). */
export type SandboxOpsFactory = (env: Env, sandboxId: string, egressHosts?: string[]) => SandboxOps;

let sandboxOpsFactory: SandboxOpsFactory | undefined;

/** Test seam for acquireSandboxOps — same detached-continuation caveat as the resolver. */
export function setSandboxOpsFactory(factory: SandboxOpsFactory | undefined): void {
  sandboxOpsFactory = factory;
}

/** Production acquire path — delegates to the existing sandbox ops factory. */
export async function acquireSandboxOps(
  env: Env,
  sandboxId: string,
  egressHosts?: string[],
): Promise<SandboxOps> {
  const create = sandboxOpsFactory ?? (await import("../agents/opencode-agent.js")).createSandboxOps;
  return create(env, sandboxId, egressHosts);
}
