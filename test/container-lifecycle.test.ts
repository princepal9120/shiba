import { Effect, Fiber } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireContainer,
  acquireSandboxOps,
  ContainerReleasedError,
  destroyManagedContainer,
  forgetLeaked,
  leakedContainerCount,
  leakedContainers,
  runWithContainer,
  setSandboxHandleResolver,
  setSandboxOpsFactory,
  type ManagedContainer,
} from "../src/sandbox/lifecycle.js";
import type { Env } from "../src/env.js";
import type { ExecResult, SandboxOps } from "../src/runtime.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  getSandbox: vi.fn(),
  createSandboxOps: vi.fn(),
}));
// The injected resolver/factory seams, not vi.mock of the SDK modules: an
// import() inside a detached async continuation can bypass interception.
mocks.getSandbox.mockImplementation(() => ({ destroy: mocks.destroy }));
setSandboxHandleResolver(mocks.getSandbox);
setSandboxOpsFactory(mocks.createSandboxOps);

function fakeEnv(): Env {
  return { Sandbox: {} } as unknown as Env;
}

function fakeOps() {
  return {
    gitCheckout: vi.fn(async (_repoUrl: string, _opts: { branch: string; targetDir: string }) => {}),
    writeFile: vi.fn(async (_path: string, _content: string) => {}),
    exec: vi.fn(
      async (
        _command: string,
        _opts?: {
          cwd?: string;
          timeoutMs?: number;
          env?: Record<string, string>;
          signal?: AbortSignal;
          onOutput?: (stream: "stdout" | "stderr", data: string) => void;
        },
      ): Promise<ExecResult> => ({ stdout: "", stderr: "", exitCode: 0 }),
    ),
    readFile: vi.fn(
      async (_path: string, _opts?: { maxBytes?: number; signal?: AbortSignal }) =>
        ({ kind: "utf8", content: "" }) as const,
    ),
  } satisfies SandboxOps;
}

describe("runWithContainer", () => {
  it("acquires, runs the task, and releases exactly once after the task", async () => {
    const ops = fakeOps();
    const order: string[] = [];
    const acquire = vi.fn(async () => {
      order.push("acquire");
      return ops;
    });
    const release = vi.fn(async (_sandboxId: string) => {
      order.push("release");
    });
    const result = await runWithContainer(
      { acquire, release, sandboxId: "sbx-order" },
      async (container) => {
        order.push("task");
        expect(container.sandboxId).toBe("sbx-order");
        expect(container.released).toBe(false);
        expect(container.leaked).toBe(false);
        expect(container.generation).toBe(0);
        await container.ops.exec("ls");
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("sbx-order");
    expect(order).toEqual(["acquire", "task", "release"]);
  });

  it("still releases when the task throws, and rethrows the task error", async () => {
    const release = vi.fn(async (_sandboxId: string) => {});
    await expect(
      runWithContainer(
        { acquire: async () => fakeOps(), release, sandboxId: "sbx-throw" },
        async () => {
          throw new Error("task boom");
        },
      ),
    ).rejects.toThrow("task boom");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("sbx-throw");
  });

  it("still releases when the abort signal fires mid-task", async () => {
    const controller = new AbortController();
    const release = vi.fn(async (_sandboxId: string) => {});
    await expect(
      runWithContainer(
        { acquire: async () => fakeOps(), release, sandboxId: "sbx-abort", signal: controller.signal },
        async () => {
          controller.abort();
          controller.signal.throwIfAborted();
        },
      ),
    ).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });

  it("passes the caller's signal through to ops opts unchanged", async () => {
    const ops = fakeOps();
    const controller = new AbortController();
    const release = vi.fn(async (_sandboxId: string) => {});
    await runWithContainer(
      { acquire: async () => ops, release, sandboxId: "sbx-signal", signal: controller.signal },
      async (container) => {
        await container.ops.exec("ls", { signal: controller.signal });
        await container.ops.readFile("/f", { signal: controller.signal });
      },
    );
    expect(ops.exec).toHaveBeenCalledWith("ls", expect.objectContaining({ signal: controller.signal }));
    expect(ops.readFile).toHaveBeenCalledWith("/f", expect.objectContaining({ signal: controller.signal }));
  });

  it("skips the task on a pre-aborted signal but still releases the acquired container", async () => {
    const controller = new AbortController();
    controller.abort();
    const release = vi.fn(async (_sandboxId: string) => {});
    const task = vi.fn(async (_container: ManagedContainer) => "unreached");
    await expect(
      runWithContainer(
        { acquire: async () => fakeOps(), release, sandboxId: "sbx-preaborted", signal: controller.signal },
        task,
      ),
    ).rejects.toThrow();
    expect(task).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("sbx-preaborted");
  });

  it("does not call release and records no leak when acquire throws", async () => {
    const release = vi.fn(async (_sandboxId: string) => {});
    const countBefore = leakedContainerCount();
    await expect(
      runWithContainer(
        {
          acquire: async () => {
            throw new Error("acquire boom");
          },
          release,
          sandboxId: "sbx-acquire-fail",
        },
        async () => {},
      ),
    ).rejects.toThrow("acquire boom");
    expect(release).not.toHaveBeenCalled();
    expect(leakedContainerCount()).toBe(countBefore);
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-acquire-fail")).toBe(false);
  });

  it("resolves with the task's plain (non-promise) return value", async () => {
    const release = vi.fn(async (_sandboxId: string) => {});
    const result = await runWithContainer(
      { acquire: async () => fakeOps(), release, sandboxId: "sbx-sync" },
      (container) => `ran:${container.sandboxId}`,
    );
    expect(result).toBe("ran:sbx-sync");
    expect(release).toHaveBeenCalledOnce();
  });

  it("fences ops after release with ContainerReleasedError and bumps generation", async () => {
    const ops = fakeOps();
    let container: ManagedContainer | undefined;
    await runWithContainer(
      { acquire: async () => ops, release: async () => {}, sandboxId: "sbx-fenced" },
      async (managed) => {
        container = managed;
      },
    );
    expect(container).toBeDefined();
    const released = container!;
    expect(released.released).toBe(true);
    expect(released.leaked).toBe(false);
    expect(released.generation).toBe(1);
    for (const call of [
      () => released.ops.gitCheckout("https://github.com/o/r", { branch: "main", targetDir: "/w" }),
      () => released.ops.writeFile("/f", "x"),
      () => released.ops.exec("ls"),
      () => released.ops.readFile("/f"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ContainerReleasedError);
      await expect(call()).rejects.toMatchObject({ name: "ContainerReleasedError" });
    }
    expect(ops.exec).not.toHaveBeenCalled();
    expect(ops.gitCheckout).not.toHaveBeenCalled();
    expect(ops.writeFile).not.toHaveBeenCalled();
    expect(ops.readFile).not.toHaveBeenCalled();
  });

  it("marks the container leaked and records it when release fails", async () => {
    const countBefore = leakedContainerCount();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let container: ManagedContainer | undefined;
    await expect(
      runWithContainer(
        {
          acquire: async () => fakeOps(),
          release: async () => {
            throw new Error("destroy boom");
          },
          sandboxId: "sbx-leak",
        },
        async (managed) => {
          container = managed;
        },
      ),
    ).rejects.toThrow("destroy boom");
    // Capture before mockRestore clears the recorded calls.
    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join(" ");
    errorSpy.mockRestore();
    expect(container!.released).toBe(true);
    expect(container!.leaked).toBe(true);
    expect(container!.generation).toBe(1);
    expect(leakedContainerCount()).toBe(countBefore + 1);
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-leak")).toBe(true);
    // A leaked container's ops reject the same as a released one's.
    await expect(container!.ops.exec("ls")).rejects.toBeInstanceOf(ContainerReleasedError);
    // The release failure is logged with the sandboxId for later reclaim —
    // and never with the raw error text (only the id is safe to print).
    expect(logged).toContain("sbx-leak");
    expect(logged).not.toContain("destroy boom");
  });

  it("task error wins over a release failure, and the leak is still recorded", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runWithContainer(
          {
            acquire: async () => fakeOps(),
            release: async () => {
              throw new Error("destroy boom");
            },
            sandboxId: "sbx-doublefail",
          },
          async () => {
            throw new Error("task boom");
          },
        ),
      ).rejects.toThrow("task boom");
    } finally {
      errorSpy.mockRestore();
    }
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-doublefail")).toBe(true);
  });

  it("forgetLeaked drops the registry entry after a successful retry", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runWithContainer(
          {
            acquire: async () => fakeOps(),
            release: async () => {
              throw new Error("destroy boom");
            },
            sandboxId: "sbx-retry",
          },
          async () => {},
        ),
      ).rejects.toThrow("destroy boom");
    } finally {
      errorSpy.mockRestore();
    }
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-retry")).toBe(true);
    forgetLeaked("sbx-retry");
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-retry")).toBe(false);
  });
});

describe("interruption-safe release", () => {
  it("rejects and releases when the caller's signal aborts an in-flight task that never settles", async () => {
    const controller = new AbortController();
    const release = vi.fn(async (_sandboxId: string) => {});
    let container: ManagedContainer | undefined;
    const run = runWithContainer(
      {
        acquire: async () => fakeOps(),
        release,
        sandboxId: "sbx-stuck",
        signal: controller.signal,
      },
      async (managed) => {
        container = managed;
        // An in-flight operation that ignores the signal entirely — only a
        // real interruption can unwind the task, and release must still run.
        await new Promise<never>(() => {});
      },
    );
    await tick();
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("sbx-stuck");
    expect(container!.released).toBe(true);
  }, 10_000);

  it("aborts an in-flight op through the scope signal when the task did not pass one", async () => {
    const controller = new AbortController();
    const ops = fakeOps();
    let seenSignal: AbortSignal | undefined;
    ops.exec.mockImplementationOnce((_command, opts) => {
      seenSignal = opts?.signal;
      return new Promise<never>((_resolve, reject) => {
        opts?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    });
    const release = vi.fn(async (_sandboxId: string) => {});
    const run = runWithContainer(
      {
        acquire: async () => ops,
        release,
        sandboxId: "sbx-ops-signal",
        signal: controller.signal,
      },
      // The op is called WITHOUT a signal: the scope supplies a fallback
      // that fires when the fiber is interrupted, so ops still abort.
      (container) => container.ops.exec("sleep 60"),
    );
    await tick();
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    expect(release).toHaveBeenCalledOnce();
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(true);
  });

  it("runs the release finalizer when the fiber is interrupted mid-task", async () => {
    const release = vi.fn(async (_sandboxId: string) => {});
    let container: ManagedContainer | undefined;
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          container = yield* acquireContainer({
            acquire: async () => fakeOps(),
            release,
            sandboxId: "sbx-fiber",
          });
          yield* Effect.never;
        }),
      ),
    );
    await tick();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("sbx-fiber");
    expect(container!.released).toBe(true);
    expect(container!.generation).toBe(1);
  });
});

describe("destroyManagedContainer", () => {
  beforeEach(() => {
    mocks.getSandbox.mockClear();
    mocks.destroy.mockReset();
    mocks.getSandbox.mockImplementation(() => ({ destroy: mocks.destroy }));
  });

  it("records a leak when destroy fails, then clears it on a successful retry", async () => {
    const env = fakeEnv();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const countBefore = leakedContainerCount();
    try {
      mocks.destroy.mockRejectedValueOnce(new Error("socket reset mid-destroy"));
      await destroyManagedContainer(env, "sbx-doomed");
    } finally {
      warnSpy.mockRestore();
    }
    expect(mocks.getSandbox).toHaveBeenCalledWith(env.Sandbox, "sbx-doomed");
    expect(leakedContainerCount()).toBe(countBefore + 1);
    const entry = leakedContainers().find((leak) => leak.sandboxId === "sbx-doomed");
    expect(entry).toBeDefined();
    // The registry keeps a redacted copy of the failure for reclaim diagnostics.
    expect(entry!.error).toContain("socket reset");

    mocks.destroy.mockResolvedValueOnce(undefined);
    await destroyManagedContainer(env, "sbx-doomed");
    expect(leakedContainers().some((leak) => leak.sandboxId === "sbx-doomed")).toBe(false);
  });

  it("swallows destroy errors without throwing (warn-and-track semantics)", async () => {
    const env = fakeEnv();
    mocks.destroy.mockRejectedValueOnce(new Error("gone"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(destroyManagedContainer(env, "sbx-soft")).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
    forgetLeaked("sbx-soft");
  });
});

describe("acquireSandboxOps", () => {
  beforeEach(() => {
    mocks.createSandboxOps.mockReset();
  });

  it("delegates to createSandboxOps with env, sandboxId, and egress hosts", async () => {
    const env = fakeEnv();
    const ops = fakeOps();
    mocks.createSandboxOps.mockReturnValueOnce(ops);
    const result = await acquireSandboxOps(env, "sbx-acq", ["api.anthropic.com"]);
    expect(mocks.createSandboxOps).toHaveBeenCalledWith(env, "sbx-acq", ["api.anthropic.com"]);
    expect(result).toBe(ops);
  });
});
