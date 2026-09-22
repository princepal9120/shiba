/**
 * Scoped container lifecycle — Effect's acquire → use → release pattern
 * ported onto the sandbox container seam.
 *
 * `runWithContainer` guarantees release runs exactly once no matter how the
 * task ends (return, throw, or parent abort). Released containers are fenced
 * by a generation bump — the same token pattern as DelegatedRun.generation in
 * src/runs.ts — so post-release ops reject with ContainerReleasedError instead
 * of silently reaching a dead container. A failed release marks the container
 * leaked and records it in a module-level registry so reclaim/onStart paths
 * can find and retry containers that could not be destroyed.
 *
 * Testability is structural: acquire/release are injected, so this module is
 * exercised without @cloudflare/sandbox. The production helpers below defer
 * their SDK imports the same way the orchestrator's destroySandbox did.
 */
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
  ) {
    this.ops = {
      gitCheckout: (repoUrl, opts) => this.call(() => inner.gitCheckout(repoUrl, opts)),
      writeFile: (path, content) => this.call(() => inner.writeFile(path, content)),
      exec: (command, opts) => this.call(() => inner.exec(command, opts)),
      readFile: (path, opts) => this.call(() => inner.readFile(path, opts)),
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
 * Acquire a container, run `task` with it, and release it exactly once in a
 * finally — release runs whether the task returns, throws, or the parent
 * AbortSignal fires mid-task. A pre-aborted signal does not skip release of a
 * container that was already acquired.
 *
 * Release failure marks the container leaked, records it for reclaim, and is
 * logged with the sandboxId only; a task error always wins over a release
 * error so the recorded outcome is never masked.
 */
export async function runWithContainer<T>(
  opts: {
    acquire: () => Promise<SandboxOps>;
    release: (sandboxId: string) => Promise<void>;
    sandboxId: string;
    signal?: AbortSignal;
  },
  task: (container: ManagedContainer) => Promise<T>,
): Promise<T> {
  const container = new ManagedContainerImpl(opts.sandboxId, await opts.acquire());
  let result: T;
  try {
    result = await task(container);
  } catch (taskError) {
    try {
      await opts.release(opts.sandboxId);
      container.markReleased();
    } catch (releaseError) {
      container.markLeaked();
      recordLeak(opts.sandboxId, releaseError);
      console.error(`Failed to release sandbox container ${opts.sandboxId}`);
    }
    throw taskError;
  }
  try {
    await opts.release(opts.sandboxId);
    container.markReleased();
  } catch (releaseError) {
    container.markLeaked();
    recordLeak(opts.sandboxId, releaseError);
    console.error(`Failed to release sandbox container ${opts.sandboxId}`);
    throw releaseError;
  }
  return result;
}

/**
 * Production release path: destroy the sandbox container, routing failures
 * through the leak registry (warn + track, never throw) so reclaim/onStart can
 * find leaked containers. A successful destroy clears any stale leak record.
 */
export async function destroyManagedContainer(env: Env, sandboxId: string): Promise<void> {
  try {
    const { getSandbox } = await import("@cloudflare/sandbox");
    await getSandbox(env.Sandbox, sandboxId).destroy();
    forgetLeaked(sandboxId);
  } catch (error) {
    // Cleanup failure must not overwrite the recorded outcome.
    console.warn(`Failed to destroy sandbox ${sandboxId}: ${redactSecrets(String(error))}`);
    recordLeak(sandboxId, error);
  }
}

/** Production acquire path — delegates to the existing sandbox ops factory. */
export async function acquireSandboxOps(
  env: Env,
  sandboxId: string,
  egressHosts?: string[],
): Promise<SandboxOps> {
  const { createSandboxOps } = await import("../agents/opencode-agent.js");
  return createSandboxOps(env, sandboxId, egressHosts);
}
